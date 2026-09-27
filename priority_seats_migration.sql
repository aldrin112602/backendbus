-- Apply before deploying the exclusive-seat API. Existing reservations are preserved.
begin;

alter table public.bookings
  add column if not exists priority_category text,
  add column if not exists priority_verified_by uuid,
  add column if not exists priority_verified_at timestamptz;

create table if not exists public.pickup_seat_verifications (
  id bigint generated always as identity primary key,
  booking_id uuid not null,
  passenger_id uuid not null,
  category text not null check (category in ('senior_citizen', 'pwd')),
  conductor_id uuid not null,
  confirmed_at timestamptz not null default now()
);
alter table public.pickup_seat_verifications enable row level security;
revoke all on public.pickup_seat_verifications from public, anon, authenticated;
grant select, insert on public.pickup_seat_verifications to service_role;
grant usage on sequence public.pickup_seat_verifications_id_seq to service_role;

create or replace function public.enforce_priority_seats()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  numbers integer[];
  old_numbers integer[] := '{}';
  added integer[];
  capacity integer;
  category text;
  priority_count integer;
  needs_confirmation boolean;
  same_scope boolean := false;
begin
  -- Only the trusted backend can attest to a physical ID check.
  if tg_op = 'INSERT' then
    needs_confirmation := new.priority_category is not null or new.priority_verified_by is not null or new.priority_verified_at is not null;
  else
    needs_confirmation := (new.priority_category, new.priority_verified_by, new.priority_verified_at)
      is distinct from (old.priority_category, old.priority_verified_by, old.priority_verified_at);
  end if;
  if needs_confirmation and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Physical ID confirmation requires the assigned conductor backend.' using errcode = '42501';
  end if;
  if new.status not in ('pending', 'confirmed', 'boarded') then return new; end if;
  if jsonb_typeof(coalesce(new.seats, '[]'::jsonb)) <> 'array' then
    raise exception 'Seats must be an array.' using errcode = '23514';
  end if;
  if exists(select 1 from jsonb_array_elements_text(coalesce(new.seats,'[]'::jsonb)) n where n !~ '^[0-9]+$') then
    raise exception 'Invalid seat number.' using errcode = '23514';
  end if;
  select coalesce(array_agg(n::integer), '{}') into numbers from jsonb_array_elements_text(coalesce(new.seats,'[]'::jsonb)) n;
  if tg_op = 'UPDATE' then
    same_scope := new.bus_id = old.bus_id and new.user_id is not distinct from old.user_id
      and new.trip_id is not distinct from old.trip_id and new.booking_type is not distinct from old.booking_type
      and (new.trip_id is not null or (new.travel_date at time zone 'Asia/Manila')::date is not distinct from (old.travel_date at time zone 'Asia/Manila')::date)
      and old.status in ('pending','confirmed','boarded');
    if same_scope then
      select coalesce(array_agg(n::integer),'{}') into old_numbers from jsonb_array_elements_text(coalesce(old.seats,'[]'::jsonb)) n;
    end if;
  end if;
  select coalesce(array_agg(n),'{}') into added from unnest(numbers) n where not(n = any(old_numbers));
  -- Unchanged seats and removals preserve legacy bookings; metadata changes still get validated.
  if cardinality(added) = 0 and not needs_confirmation then return new; end if;
  if cardinality(numbers) = 0 then
    if new.priority_category is not null or new.priority_verified_by is not null or new.priority_verified_at is not null then
      raise exception 'Only a seated pickup can record physical ID confirmation.' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.user_id is null or (new.trip_id is null and new.travel_date is null) then
    raise exception 'Passenger and trip or travel date are required.' using errcode = '23514';
  end if;
  if coalesce(auth.role(),'') <> 'service_role' and auth.uid() is distinct from new.user_id then
    raise exception 'Passenger identity does not match.' using errcode = '42501';
  end if;
  -- Serialize allocations per bus, including requests from different API instances.
  perform pg_advisory_xact_lock(hashtextextended(new.bus_id::text, 87241));
  select total_seats into capacity from public.buses where id = new.bus_id;
  if capacity is null or (capacity < 8 and cardinality(added) > 0) then
    raise exception 'Bus must have at least 8 seats.' using errcode = '23514';
  end if;
  if new.trip_id is not null and not exists(select 1 from public.bus_trips where id = new.trip_id and bus_id = new.bus_id) then
    raise exception 'Invalid trip for this bus.' using errcode = '23514';
  end if;
  if exists(select 1 from unnest(numbers) n where n < 1 or n > capacity)
    or cardinality(numbers) <> (select count(distinct n) from unnest(numbers) n) then
    raise exception 'Invalid or duplicate seats.' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.bookings b cross join lateral jsonb_array_elements_text(coalesce(b.seats,'[]'::jsonb)) n
    where b.id is distinct from new.id and b.bus_id = new.bus_id and b.status in ('pending','confirmed','boarded')
      and ((new.trip_id is not null and b.trip_id = new.trip_id) or
        (new.trip_id is null and b.trip_id is null and (b.travel_date at time zone 'Asia/Manila')::date = (new.travel_date at time zone 'Asia/Manila')::date))
      and n::integer = any(added)
  ) then raise exception 'Seat already taken. Refresh seat availability.' using errcode = '23505'; end if;
  select count(*) into priority_count from unnest(numbers) n where n <= 8;
  if exists(select 1 from unnest(added) n where n <= 8) then
    if priority_count > 1 or exists (
      select 1 from public.bookings b cross join lateral jsonb_array_elements_text(coalesce(b.seats,'[]'::jsonb)) n
      where b.id is distinct from new.id and b.bus_id = new.bus_id and b.user_id = new.user_id
        and b.status in ('pending','confirmed','boarded') and n::integer between 1 and 8
        and ((new.trip_id is not null and b.trip_id = new.trip_id) or
          (new.trip_id is null and b.trip_id is null and (b.travel_date at time zone 'Asia/Manila')::date = (new.travel_date at time zone 'Asia/Manila')::date))
    ) then raise exception 'Only one exclusive seat per passenger account per trip.' using errcode = '23514'; end if;
    if new.booking_type = 'pickup_request' then
      if not needs_confirmation or new.priority_verified_by is null or new.priority_verified_at is null then
        raise exception 'Confirm the physical senior/PWD ID before assigning an exclusive seat.' using errcode = '23514';
      end if;
      category := new.priority_category;
    else
      select type into category from public.discount_verifications
        where user_id = new.user_id and status = 'approved' and type in ('senior_citizen','pwd') limit 1;
    end if;
    if category is null or exists(select 1 from unnest(added) n where n <= 8 and
      (case when n <= 4 then 'senior_citizen' else 'pwd' end) <> category) then
      raise exception 'Exclusive seat category does not match passenger eligibility.' using errcode = '42501';
    end if;
  end if;
  if needs_confirmation and new.priority_category is not null then
    if new.booking_type <> 'pickup_request' or priority_count <> 1 or new.priority_category not in ('senior_citizen','pwd')
      or new.priority_verified_at is null or not exists (
        select 1 from public.users u where u.id = new.priority_verified_by and u.assigned_bus_id = new.bus_id
          and u.status = 'active' and (u.role = 'conductor' or (u.role = 'employee' and lower(u.profile->>'position') = 'conductor'))
      ) or exists(select 1 from unnest(numbers) n where n <= 8 and
        (case when n <= 4 then 'senior_citizen' else 'pwd' end) <> new.priority_category) then
      raise exception 'Invalid conductor ID confirmation.' using errcode = '42501';
    end if;
    insert into public.pickup_seat_verifications(booking_id,passenger_id,category,conductor_id,confirmed_at)
      values(new.id,new.user_id,new.priority_category,new.priority_verified_by,new.priority_verified_at);
  end if;
  return new;
end $$;

drop trigger if exists enforce_priority_seats on public.bookings;
create trigger enforce_priority_seats before insert or update on public.bookings
  for each row execute function public.enforce_priority_seats();
revoke all on function public.enforce_priority_seats() from public;

create index if not exists bookings_priority_scope on public.bookings(bus_id,trip_id,user_id,travel_date)
  where status in ('pending','confirmed','boarded');

create or replace function public.enforce_bus_seat_minimum()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.total_seats < 8 then raise exception 'A bus requires at least 8 seats.' using errcode = '23514'; end if;
  elsif new.total_seats is distinct from old.total_seats and new.total_seats < 8 then
    raise exception 'A bus requires at least 8 seats.' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists enforce_bus_seat_minimum on public.buses;
create trigger enforce_bus_seat_minimum before insert or update of total_seats on public.buses
  for each row execute function public.enforce_bus_seat_minimum();
commit;
