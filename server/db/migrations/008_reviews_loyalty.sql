-- Sprint 3 / Module 9 - reviews (R9), loyalty and offers (R14), password reset (US1.6)

CREATE TABLE reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,  -- one review per booking (US7.1 #3)
  customer_id     uuid NOT NULL REFERENCES users(id),
  cab_id          uuid REFERENCES cabs(id),
  driver_id       uuid REFERENCES drivers(id),
  journey_rating  int NOT NULL CHECK (journey_rating BETWEEN 1 AND 5),
  cab_rating      int NOT NULL CHECK (cab_rating BETWEEN 1 AND 5),
  driver_rating   int NOT NULL CHECK (driver_rating BETWEEN 1 AND 5),
  comment         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_driver_idx ON reviews(driver_id);
CREATE INDEX reviews_cab_idx ON reviews(cab_id);

CREATE TABLE offers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  title        text NOT NULL,
  discount_pct int NOT NULL CHECK (discount_pct BETWEEN 1 AND 50),
  expires_at   timestamptz NOT NULL,
  open         boolean NOT NULL DEFAULT false,   -- true: any customer may use the code; false: only the recipients
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE offer_recipients (
  offer_id  uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sent_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (offer_id, user_id)
);

-- A customer can use each code once ("already used" error, US10.4 #2). Cancelling the booking releases it.
CREATE TABLE offer_redemptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id    uuid NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offer_id, user_id)
);

CREATE TABLE password_resets (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets(user_id);
