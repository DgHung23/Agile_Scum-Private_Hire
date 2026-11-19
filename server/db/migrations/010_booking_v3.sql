-- Backlog v3, Epics "Book a Cab" and "Availability and Payment":
-- ID-29, ID-30, ID-31, ID-32, ID-38, ID-39, ID-40, ID-41, ID-48, ID-50, ID-51, ID-52, ID-53, ID-54, ID-55, ID-56, ID-57,
-- ID-73, ID-75, ID-76, N15, N16. Report: Figure 25 (booking states), Figures F2 and F3 (booking, coupons, discounts).

/* ---------- booking states (report Figure 25) ---------- */
-- pending_payment -> confirmed -> assigned (Driver assigned) -> on_route -> arrived -> in_progress -> completed
-- exceptions: cancelled, company_cancelled, no_show, interrupted, abandoned (payment never completed)
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN (
  'pending_payment', 'confirmed', 'assigned', 'on_route', 'arrived', 'in_progress', 'completed',
  'cancelled', 'company_cancelled', 'no_show', 'interrupted', 'abandoned'));

-- A cab or driver is held by every booking except the released states.
ALTER TABLE bookings DROP CONSTRAINT bookings_cab_no_overlap;
ALTER TABLE bookings DROP CONSTRAINT bookings_driver_no_overlap;
ALTER TABLE bookings ADD CONSTRAINT bookings_cab_no_overlap EXCLUDE USING gist
  (cab_id WITH =, tstzrange(pickup_at, end_at) WITH &&) WHERE (status NOT IN ('cancelled', 'company_cancelled', 'abandoned'));
ALTER TABLE bookings ADD CONSTRAINT bookings_driver_no_overlap EXCLUDE USING gist
  (driver_id WITH =, tstzrange(pickup_at, end_at) WITH &&)
  WHERE (status NOT IN ('cancelled', 'company_cancelled', 'abandoned') AND driver_id IS NOT NULL);

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_status_check CHECK (payment_status IN (
  'unpaid', 'pending', 'paid', 'due_cash', 'invoice', 'refunded', 'partially_refunded'));

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_passengers_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_passengers_check CHECK (passengers BETWEEN 1 AND 8);

ALTER TABLE bookings
  ADD COLUMN hold_expires_at   timestamptz,                         -- pending_payment holds the cab for 15 minutes
  ADD COLUMN group_id          uuid,                                -- N16: outward and return journeys share a group
  ADD COLUMN return_of         uuid REFERENCES bookings(id),        -- N16: the outward booking of a return journey
  ADD COLUMN luggage           int NOT NULL DEFAULT 0 CHECK (luggage BETWEEN 0 AND 12),          -- ID-30
  ADD COLUMN child_seat_ages   int[] NOT NULL DEFAULT '{}',          -- ID-30: one entry per child seat
  ADD COLUMN pet               boolean NOT NULL DEFAULT false,       -- ID-30 (an assistance dog is not a pet)
  ADD COLUMN accessibility     text[] NOT NULL DEFAULT '{}',         -- ID-39: wheelchair, assistance_dog, help_find_car
  ADD COLUMN passenger_name    text,                                 -- ID-38: booking for another passenger
  ADD COLUMN passenger_phone   text,
  ADD COLUMN flight_no         text,                                 -- ID-41
  ADD COLUMN note_to_driver    text,                                 -- N15
  ADD COLUMN package_code      text,                                 -- ID-75
  ADD COLUMN surcharge_total   numeric(8,2) NOT NULL DEFAULT 0,      -- ID-52
  ADD COLUMN price_lines       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ID-32: the breakdown shown before payment
  ADD COLUMN terms_accepted_at timestamptz,                          -- ID-32: terms and cancellation policy accepted
  ADD COLUMN asap              boolean NOT NULL DEFAULT false;       -- ID-40

CREATE INDEX bookings_group_idx ON bookings(group_id);
CREATE INDEX bookings_hold_idx ON bookings(hold_expires_at) WHERE status = 'pending_payment';

/* ---------- fleet attributes used by booking (Figure F7) ---------- */
ALTER TABLE cab_sizes ADD COLUMN luggage int NOT NULL DEFAULT 2;   -- suitcases that fit
UPDATE cab_sizes SET luggage = CASE code WHEN 'saloon' THEN 2 WHEN 'estate' THEN 4 WHEN 'mpv6' THEN 4 WHEN 'mpv7' THEN 5 ELSE 8 END;
ALTER TABLE cabs ADD COLUMN wheelchair_accessible boolean NOT NULL DEFAULT false;  -- ID-39, ID-65
-- ID-65: an Unavailable vehicle (for example broken down, N30) cannot be offered or assigned; `active = false` is Deactivated.
ALTER TABLE cabs ADD COLUMN status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'unavailable'));
ALTER TABLE cabs ADD COLUMN status_reason text;
-- ID-46: the customer sees the driver's first name, licence number and photo.
ALTER TABLE drivers ADD COLUMN photo_url text;
-- Some larger vehicles are wheelchair accessible.
UPDATE cabs SET wheelchair_accessible = true WHERE size_code IN ('mpv7', 'minibus');

/* ---------- ID-75: daily hire packages ---------- */
CREATE TABLE hire_packages (
  code    text PRIMARY KEY,
  label   text NOT NULL,
  hours   int NOT NULL CHECK (hours BETWEEN 1 AND 24),
  price   numeric(8,2) NOT NULL,      -- for a saloon; other sizes use the size multiplier
  active  boolean NOT NULL DEFAULT true,
  sort    int NOT NULL DEFAULT 0
);
INSERT INTO hire_packages (code, label, hours, price, sort) VALUES
  ('half_day', 'Half day (4 hours)', 4, 105.00, 1),
  ('full_day', 'Full day (8 hours)', 8, 199.00, 2),
  ('long_day', 'Long day (12 hours)', 12, 285.00, 3);

/* ---------- ID-52 surcharges and ID-76 prices: data the Manager edits ---------- */
INSERT INTO settings (key, value, description) VALUES
  ('night_surcharge_pct',   '20',   'ID-52: night surcharge (pickups 22:00 to 05:59), percent of the fare'),
  ('zone_surcharge_gbp',    '2.50', 'ID-52: central London zone surcharge (pickup or destination in the zone)'),
  ('weather_surcharge_pct', '0',    'ID-52: bad-weather surcharge, percent of the fare (0 = off)'),
  ('min_fare_gbp',          '5',    'ID-31: the fare never falls below this amount after discounts'),
  ('hold_minutes',          '15',   'ID-53: a booking waiting for payment holds its cab for this long'),
  ('max_days_ahead',        '90',   'ID-29: furthest pickup date that can be booked'),
  ('min_lead_minutes',      '30',   'ID-29: earliest pickup, in minutes from now')
ON CONFLICT (key) DO NOTHING;

/* ---------- coupons (Figure F3): fixed amounts, one use per account ---------- */
ALTER TABLE offers RENAME TO coupons;
ALTER TABLE offer_recipients RENAME TO customer_coupons;     -- the customer's wallet ("My coupons")
ALTER TABLE offer_redemptions RENAME TO coupon_redemptions;
ALTER TABLE coupons ADD COLUMN amount numeric(8,2);
UPDATE coupons SET amount = GREATEST(1, LEAST(20, discount_pct)) WHERE amount IS NULL;
ALTER TABLE coupons ALTER COLUMN amount SET NOT NULL;
ALTER TABLE coupons ADD CONSTRAINT coupons_amount_check CHECK (amount > 0 AND amount <= 100);
ALTER TABLE coupons DROP COLUMN discount_pct;
ALTER TABLE bookings RENAME COLUMN offer_pct TO coupon_amount;    -- re-applied when the booking is amended
UPDATE bookings SET coupon_amount = discount_offer;

-- Figure F3: APPLIED_DISCOUNT, in the order they were applied (programme first, then one coupon).
CREATE TABLE applied_discounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('programme', 'coupon')),
  label       text NOT NULL,
  amount      numeric(8,2) NOT NULL,
  sequence    int NOT NULL
);
CREATE INDEX applied_discounts_booking_idx ON applied_discounts(booking_id, sequence);
INSERT INTO applied_discounts (booking_id, kind, label, amount, sequence)
  SELECT id, 'programme', 'Online booking discount', discount_online, 1 FROM bookings WHERE discount_online > 0;
INSERT INTO applied_discounts (booking_id, kind, label, amount, sequence)
  SELECT id, 'coupon', 'Coupon ' || offer_code, discount_offer, 2 FROM bookings WHERE discount_offer > 0;

/* ---------- payments: 3D Secure, cash to the driver, pay by bank (ID-53 to ID-57) ---------- */
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method IN ('card', 'paypal', 'cash', 'bank', 'invoice'));
ALTER TABLE payments ADD COLUMN sca_verified boolean NOT NULL DEFAULT false;   -- 3D Secure passed
ALTER TABLE payments ADD COLUMN bank_name text;

-- One 3D Secure challenge per card attempt. The card number is never stored: only what a saved card would keep.
CREATE TABLE sca_challenges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount        numeric(8,2) NOT NULL,
  brand         text NOT NULL,
  last4         text NOT NULL,
  exp_month     int,
  exp_year      int,
  holder_name   text,
  sim_outcome   text NOT NULL,
  saved_card_id uuid REFERENCES saved_cards(id) ON DELETE SET NULL,
  save_card     boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed', 'declined', 'expired')),
  attempts      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);
CREATE INDEX sca_challenges_group_idx ON sca_challenges(group_id);

-- PayPal and pay-by-bank both redirect to the provider and back (simulated).
ALTER TABLE paypal_sessions RENAME TO redirect_sessions;
ALTER TABLE redirect_sessions
  ADD COLUMN provider  text NOT NULL DEFAULT 'paypal' CHECK (provider IN ('paypal', 'bank')),
  ADD COLUMN group_id  uuid,
  ADD COLUMN bank_name text;
