const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('priority migration and database enforcement (isolated PostgreSQL)', async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role',true) $$;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      set request.jwt.claim.role = 'service_role';
      create table buses(id uuid primary key, total_seats integer not null);
      create table users(id uuid primary key, role text, assigned_bus_id uuid, status text default 'active', profile jsonb default '{}');
      create table bus_trips(id uuid primary key, bus_id uuid);
      create table discount_verifications(user_id uuid, type text, status text);
      create table bookings(id uuid primary key default gen_random_uuid(),user_id uuid,bus_id uuid,trip_id uuid,travel_date timestamptz,
        status text default 'pending',seats jsonb default '[]',booking_type text default 'regular',seat_assignment text default 'reserved');
      insert into buses values('${id(1)}',40),('${id(2)}',6);
      insert into bus_trips values('${id(30)}','${id(1)}'),('${id(31)}','${id(1)}'),('${id(32)}','${id(1)}');
      insert into users(id,role,assigned_bus_id) values('${id(10)}','client',null),('${id(11)}','client',null),('${id(12)}','client',null),('${id(13)}','client',null),
        ('${id(20)}','conductor','${id(1)}'),('${id(21)}','conductor','${id(2)}');
      insert into discount_verifications values('${id(10)}','senior_citizen','approved'),('${id(11)}','pwd','approved'),('${id(13)}','senior_citizen','approved');
      insert into bookings(id,user_id,bus_id,travel_date,seats) values('${id(99)}','${id(12)}','${id(1)}','2026-01-01T08:00:00+08:00','[1,2]');
    `);
    const migration = fs.readFileSync(require.resolve('../priority_seats_migration.sql'), 'utf8');
    await db.exec(migration);
    await db.exec(migration); // Must be safe to reapply without losing audit history.
    const insert = async (user, seats, extra = {}) => {
      const record = { user_id:id(user),bus_id:id(1),trip_id:id(30),travel_date:'2026-10-02T08:00:00+08:00',seats:JSON.stringify(seats),...extra };
      const columns = Object.keys(record);
      const values = Object.values(record);
      return (await db.query(`insert into bookings(${columns.join(',')}) values(${values.map((_,i)=>'$'+(i+1)).join(',')}) returning *`,values)).rows[0];
    };
    const rejected = async (fn, pattern) => {
      await db.exec('savepoint rejected');
      try { await assert.rejects(fn, pattern); } finally { await db.exec('rollback to savepoint rejected'); }
    };
    const scenario = (name, fn) => t.test(name, async () => {
      await db.exec('begin');
      try { await fn(); } finally { await db.exec('rollback'); }
    });
    await scenario('approved matching category, regular companions, wrong category and unverified rejection', async () => {
      await insert(10,[1,9]); await insert(11,[5,10]); await insert(12,[11]);
      await rejected(()=>insert(12,[2]), /eligibility/);
      await rejected(()=>insert(13,[6]), /eligibility/);
    });
    await scenario('one exclusive seat across bookings and no duplicate seat allocation', async () => {
      await insert(10,[1]);
      await rejected(()=>insert(10,[2]), /Only one/);
      await rejected(()=>insert(13,[1]), /already taken/);
      await rejected(()=>insert(13,[2,3]), /Only one/);
    });
    await scenario('cancellation releases seats but reactivation validates eligibility again', async () => {
      const booking = await insert(10,[1]);
      await db.query("update bookings set status='cancelled' where id=$1",[booking.id]);
      await insert(13,[1]);
      await rejected(()=>db.query("update bookings set status='pending' where id=$1",[booking.id]), /already taken/);
      await rejected(()=>insert(12,[1], {status:'pending'}), /already taken/);
    });
    await scenario('legacy reservations survive status changes and regular seat additions', async () => {
      await db.query("update bookings set status='confirmed',seats='[1,2,9]' where id=$1",[id(99)]);
      await rejected(()=>db.query("update bookings set seats='[1,2,3]' where id=$1",[id(99)]), /Only one/);
      assert.equal((await db.query('select seats from bookings where id=$1',[id(99)])).rows[0].seats.length,3);
    });
    await scenario('pickup physical ID does not require online approval and audit is retained', async () => {
      await rejected(()=>insert(12,[5], {booking_type:'pickup_request'}), /physical/);
      await rejected(()=>insert(12,[5], {booking_type:'pickup_request',priority_category:'pwd',priority_verified_by:id(21),priority_verified_at:new Date().toISOString()}), /conductor/);
      const booking = await insert(12,[5], {booking_type:'pickup_request',priority_category:'pwd',priority_verified_by:id(20),priority_verified_at:new Date().toISOString()});
      assert.equal((await db.query('select count(*)::int as count from pickup_seat_verifications')).rows[0].count,1);
      assert.equal((await db.query('select count(*)::int as count from discount_verifications where user_id=$1',[id(12)])).rows[0].count,0);
      await rejected(()=>db.query("update bookings set seats='[1]' where id=$1",[booking.id]), /physical/);
      await db.query("update bookings set seats='[1]',priority_category='senior_citizen',priority_verified_at=clock_timestamp() where id=$1",[booking.id]);
      assert.equal((await db.query('select count(*)::int as count from pickup_seat_verifications')).rows[0].count,2);
    });
    await scenario('untrusted clients cannot forge a conductor confirmation', async () => {
      await db.exec(`set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub='${id(12)}';`);
      await rejected(()=>insert(12,[5], {booking_type:'pickup_request',priority_category:'pwd',priority_verified_by:id(20),priority_verified_at:new Date().toISOString()}), /conductor backend/);
    });
    await scenario('legacy date scope uses Manila day and separate trips stay independent', async () => {
      await insert(10,[1], {trip_id:null,travel_date:'2026-10-01T20:00:00Z'});
      await rejected(()=>insert(10,[2], {trip_id:null,travel_date:'2026-10-02T00:00:00Z'}), /Only one/);
      await insert(10,[1], {trip_id:id(31)});
      await insert(10,[1], {trip_id:id(32)});
    });
    await scenario('small buses cannot allocate new seats, existing capacity unchanged', async () => {
      await rejected(()=>insert(10,[1],{bus_id:id(2),trip_id:null}), /at least 8/);
      await rejected(()=>db.query('update buses set total_seats=7 where id=$1',[id(1)]), /at least 8/);
      assert.equal((await db.query('select total_seats from buses where id=$1',[id(1)])).rows[0].total_seats,40);
    });
    // PGlite serializes connections; this tests duplicate submissions against the
    // real SQL guard, not multi-process PostgreSQL lock contention.
    await t.test('simultaneous submissions cannot allocate the same exclusive seat twice', async () => {
      const results = await Promise.allSettled([insert(10,[3]),insert(13,[3])]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(results.filter(r=>r.status==='rejected').length,1);
      assert.equal((await db.query("select count(*)::int as count from bookings where trip_id=$1 and seats @> '[3]'",[id(30)])).rows[0].count,1);
    });
  } finally { await db.close(); }
});
