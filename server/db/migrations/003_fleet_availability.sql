-- Sprint 1 / Module 3 - fleet, drivers, services and the bookings table with double-booking protection

-- Cab sizes (R5: "the size of the minicab required e.g. a seven-seater")
CREATE TABLE cab_sizes (
  code        text PRIMARY KEY,
  label       text NOT NULL,
  seats       int  NOT NULL CHECK (seats BETWEEN 1 AND 16),
  multiplier  numeric(4,2) NOT NULL DEFAULT 1.00,  -- applied to the distance part of the fare
  sort        int  NOT NULL DEFAULT 0
);
INSERT INTO cab_sizes (code, label, seats, multiplier, sort) VALUES
  ('saloon',  'Saloon (4 seats)',        4, 1.00, 1),
  ('estate',  'Estate (5 seats)',        5, 1.15, 2),
  ('mpv6',    'MPV (6 seats)',           6, 1.35, 3),
  ('mpv7',    'Seven-seater',            7, 1.50, 4),
  ('minibus', 'Minibus (8 seats)',       8, 1.75, 5);

-- R4: the services customers choose from
CREATE TABLE services (
  code         text PRIMARY KEY,
  label        text NOT NULL,
  description  text NOT NULL,
  base_fare    numeric(8,2) NOT NULL DEFAULT 0,
  per_mile     numeric(8,2) NOT NULL DEFAULT 0,
  hourly_rate  numeric(8,2),            -- only for hourly services (daily hire)
  extra_fee    numeric(8,2) NOT NULL DEFAULT 0,
  min_fare     numeric(8,2) NOT NULL DEFAULT 0,
  min_hours    int,
  max_hours    int,
  is_hourly    boolean NOT NULL DEFAULT false,
  needs_airport boolean NOT NULL DEFAULT false,
  active       boolean NOT NULL DEFAULT true,
  sort         int NOT NULL DEFAULT 0
);
INSERT INTO services (code, label, description, base_fare, per_mile, hourly_rate, extra_fee, min_fare, min_hours, max_hours, is_hourly, needs_airport, sort) VALUES
  ('local',         'Local journey',          'Door to door across London, any time of day.',                4.00, 2.20, NULL,  0.00,  8.00, NULL, NULL, false, false, 1),
  ('long_distance', 'Long distance',          'Comfortable intercity trips at a clear price.',              10.00, 1.80, NULL,  0.00, 35.00, NULL, NULL, false, false, 2),
  ('airport',       'Airport transfer',       'Heathrow, Gatwick, City, Stansted and Luton.',                8.00, 2.00, NULL,  5.00, 25.00, NULL, NULL, false, true,  3),
  ('hotel',         'Hotel transfer',         'Arrive and leave in style from any London hotel.',            5.00, 2.10, NULL,  0.00, 12.00, NULL, NULL, false, false, 4),
  ('meet_greet',    'Meet & greet at airport','Your driver meets you inside the arrivals hall with a name board.', 8.00, 2.00, NULL, 15.00, 40.00, NULL, NULL, false, true,  5),
  ('daily_hire',    'Driver & car by the day','A car and driver at your disposal, charged by the hour.',     0.00, 0.00, 28.00, 0.00,  0.00, 4,    12,   true,  false, 6);

CREATE TABLE cabs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reg         text NOT NULL,
  make        text NOT NULL,
  model       text NOT NULL,
  colour      text NOT NULL,
  size_code   text NOT NULL REFERENCES cab_sizes(code),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- US9.6: registration numbers must be unique (ignoring case and spaces)
CREATE UNIQUE INDEX cabs_reg_unique ON cabs (replace(upper(reg), ' ', ''));
CREATE INDEX cabs_size_idx ON cabs(size_code) WHERE active;

CREATE TABLE drivers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   text NOT NULL,
  phone       text NOT NULL,
  licence_no  text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Known London places: autocomplete + distance estimates (haversine). Free-text addresses are also accepted.
CREATE TABLE locations (
  id     serial PRIMARY KEY,
  name   text NOT NULL UNIQUE,
  kind   text NOT NULL CHECK (kind IN ('airport', 'station', 'hotel', 'landmark', 'area')),
  lat    numeric(9,6) NOT NULL,
  lng    numeric(9,6) NOT NULL
);

-- Bookings. end_at includes a turnaround buffer so back-to-back jobs are realistic.
CREATE TABLE bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref              text NOT NULL UNIQUE,
  customer_id      uuid NOT NULL REFERENCES users(id),
  service_code     text NOT NULL REFERENCES services(code),
  pickup           text NOT NULL,
  destination      text NOT NULL,
  distance_miles   numeric(7,1) NOT NULL DEFAULT 0,
  hours            int,
  pickup_at        timestamptz NOT NULL,
  end_at           timestamptz NOT NULL,
  passengers       int NOT NULL CHECK (passengers BETWEEN 1 AND 16),
  size_code        text NOT NULL REFERENCES cab_sizes(code),
  cab_id           uuid NOT NULL REFERENCES cabs(id),
  driver_id        uuid REFERENCES drivers(id),
  channel          text NOT NULL DEFAULT 'online' CHECK (channel IN ('online', 'phone', 'in_person')),
  priority         boolean NOT NULL DEFAULT false,
  notify_pref      text NOT NULL DEFAULT 'email' CHECK (notify_pref IN ('email', 'text', 'both')),
  notify_phone     text,
  status           text NOT NULL DEFAULT 'confirmed'
                     CHECK (status IN ('confirmed', 'assigned', 'on_route', 'completed', 'cancelled')),
  price_full       numeric(8,2) NOT NULL,
  discount_online  numeric(8,2) NOT NULL DEFAULT 0,
  discount_offer   numeric(8,2) NOT NULL DEFAULT 0,
  offer_code       text,
  total            numeric(8,2) NOT NULL,
  eta_minutes      int,
  arrival_sms_sent_at timestamptz,
  created_by       uuid REFERENCES users(id),
  cancelled_at     timestamptz,
  cancel_reason    text,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > pickup_at),
  -- US5.1 criterion 2: a cab (or driver) can never be double-booked, enforced by the database itself
  CONSTRAINT bookings_cab_no_overlap EXCLUDE USING gist
    (cab_id WITH =, tstzrange(pickup_at, end_at) WITH &&) WHERE (status <> 'cancelled'),
  CONSTRAINT bookings_driver_no_overlap EXCLUDE USING gist
    (driver_id WITH =, tstzrange(pickup_at, end_at) WITH &&) WHERE (status <> 'cancelled' AND driver_id IS NOT NULL)
);
CREATE INDEX bookings_customer_idx ON bookings(customer_id, pickup_at DESC);
CREATE INDEX bookings_pickup_idx ON bookings(pickup_at);
CREATE INDEX bookings_status_idx ON bookings(status);

ALTER TABLE notifications ADD CONSTRAINT notifications_booking_fk FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;
