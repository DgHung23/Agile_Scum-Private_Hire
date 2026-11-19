-- Backlog v3, Epics "Receipt" and "Notifications": ID-59, N37, N38, N39 (receipt features), ID-44, ID-45, ID-47,
-- N19, N20, N21, N22. Report: functional requirements FR-6.1 to FR-6.10 and FR-4.1 to FR-4.4, feature flow F4.

/* ---------- receipts and credit notes (N39) ---------- */
CREATE TABLE receipts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             text NOT NULL UNIQUE,                       -- RC-... for receipts, CN-... for credit notes
  kind               text NOT NULL CHECK (kind IN ('receipt', 'credit_note')),
  booking_id         uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  customer_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_id         uuid UNIQUE REFERENCES payments(id) ON DELETE SET NULL,   -- created once per payment
  related_receipt_id uuid REFERENCES receipts(id) ON DELETE SET NULL,          -- a credit note points at its receipt
  amount             numeric(8,2) NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX receipts_customer_idx ON receipts(customer_id, created_at DESC);
CREATE INDEX receipts_booking_idx ON receipts(booking_id);

-- N38: every send of a receipt (who, to which address, when, result).
CREATE TABLE receipt_sends (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id       uuid NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  booking_id       uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  to_addr          text NOT NULL,
  sent_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  notification_id  uuid REFERENCES notifications(id) ON DELETE SET NULL,
  automatic        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX receipt_sends_booking_idx ON receipt_sends(booking_id, created_at DESC);

/* ---------- message delivery with retries (ID-44) ---------- */
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check CHECK (status IN ('queued', 'retrying', 'sent', 'failed'));
ALTER TABLE notifications
  ADD COLUMN attempts         int NOT NULL DEFAULT 0,
  ADD COLUMN last_error       text,
  ADD COLUMN delivered_at     timestamptz,
  ADD COLUMN next_attempt_at  timestamptz,
  ADD COLUMN attachment_name  text,
  ADD COLUMN receipt_id       uuid REFERENCES receipts(id) ON DELETE SET NULL;
UPDATE notifications SET attempts = 1, delivered_at = created_at WHERE status = 'sent';
CREATE INDEX notifications_queue_idx ON notifications(next_attempt_at) WHERE status IN ('queued', 'retrying');

/* ---------- N19 reminder, ID-45 late text ---------- */
ALTER TABLE bookings
  ADD COLUMN reminder_sent_at  timestamptz,
  ADD COLUMN late_sms_sent_at  timestamptz;

/* ---------- N21 share my trip ---------- */
CREATE TABLE trip_shares (
  token_hash  text PRIMARY KEY,
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  created_by  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact     text,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trip_shares_booking_idx ON trip_shares(booking_id);

/* ---------- N20 problem with my journey, N22 emergency button ---------- */
CREATE TABLE incidents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  reported_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  kind         text NOT NULL CHECK (kind IN ('emergency', 'problem', 'breakdown', 'found_item')),
  message      text,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handled')),
  handled_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  handled_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX incidents_open_idx ON incidents(created_at DESC) WHERE status = 'open';

-- Receipts for payments that already exist (each approved charge gets one; each refund a credit note).
INSERT INTO receipts (number, kind, booking_id, customer_id, payment_id, amount, created_at)
  SELECT 'RC-' || substr(b.ref, 4) || CASE WHEN rn > 1 THEN '-' || rn ELSE '' END, 'receipt', p.booking_id, b.customer_id, p.id, p.amount, p.created_at
    FROM (SELECT p.*, row_number() OVER (PARTITION BY booking_id ORDER BY created_at) AS rn
            FROM payments p WHERE kind = 'charge' AND status = 'approved' AND booking_id IS NOT NULL) p
    JOIN bookings b ON b.id = p.booking_id;
INSERT INTO receipts (number, kind, booking_id, customer_id, payment_id, related_receipt_id, amount, created_at)
  SELECT 'CN-' || substr(b.ref, 4) || '-' || rn, 'credit_note', p.booking_id, b.customer_id, p.id,
         (SELECT r.id FROM receipts r WHERE r.booking_id = p.booking_id AND r.kind = 'receipt' ORDER BY r.created_at LIMIT 1),
         p.amount, p.created_at
    FROM (SELECT p.*, row_number() OVER (PARTITION BY booking_id ORDER BY created_at) AS rn
            FROM payments p WHERE kind = 'refund' AND status = 'approved' AND booking_id IS NOT NULL) p
    JOIN bookings b ON b.id = p.booking_id;
