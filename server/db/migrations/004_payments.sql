-- Sprint 2 / Module 5 - payments, saved cards, receipts
-- Card numbers and CVV are NEVER stored. A saved card keeps only brand, last 4 digits, expiry and an opaque gateway token.
-- Payment gateways (VISA Check, PayPal) are simulated in server/src/services/payments.js.

ALTER TABLE bookings
  ADD COLUMN payment_status text NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid', 'paid', 'refunded', 'partially_refunded'));

CREATE TABLE saved_cards (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand          text NOT NULL CHECK (brand IN ('visa', 'mastercard', 'amex')),
  last4          text NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  exp_month      int  NOT NULL CHECK (exp_month BETWEEN 1 AND 12),
  exp_year       int  NOT NULL,
  holder_name    text NOT NULL,
  gateway_token  text NOT NULL,          -- opaque vault token (simulated)
  sim_outcome    text NOT NULL DEFAULT 'approve',  -- SIMULATION ONLY: how the fake bank answers for this card
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_cards_user_idx ON saved_cards(user_id);

-- Every charge / refund. Declined attempts are kept too (booking_id NULL because the booking was rolled back).
CREATE TABLE payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid REFERENCES bookings(id) ON DELETE SET NULL,
  user_id        uuid NOT NULL REFERENCES users(id),
  kind           text NOT NULL CHECK (kind IN ('charge', 'refund')),
  method         text NOT NULL CHECK (method IN ('card', 'paypal', 'cash')),
  amount         numeric(8,2) NOT NULL,   -- always positive; kind says the direction
  status         text NOT NULL CHECK (status IN ('approved', 'declined')),
  card_brand     text,
  card_last4     text,
  paypal_payer   text,
  gateway_ref    text,
  decline_reason text,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_booking_idx ON payments(booking_id);
CREATE INDEX payments_user_idx ON payments(user_id, created_at DESC);

-- Simulated PayPal approval sessions (US5.4)
CREATE TABLE paypal_sessions (
  token        text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  amount       numeric(8,2) NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'cancelled', 'used')),
  payer_email  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
