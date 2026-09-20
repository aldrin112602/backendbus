-- Apply before deploying the booking pricing backend/frontend.
-- NULL values intentionally preserve unknown historical pricing.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS fare_per_passenger numeric(12,2),
  ADD COLUMN IF NOT EXISTS passenger_count integer,
  ADD COLUMN IF NOT EXISTS subtotal numeric(12,2),
  ADD COLUMN IF NOT EXISTS discount_type text,
  ADD COLUMN IF NOT EXISTS discount_percent numeric(5,2),
  ADD COLUMN IF NOT EXISTS discount_amount numeric(12,2);
