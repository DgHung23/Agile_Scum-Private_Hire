-- Backlog v3, Epics "Fleet and Driver Management" and "Cancel or Amend" (staff side):
-- ID-65, ID-66, ID-67, ID-68, ID-77, ID-78, ID-79, N18, N26, N27, N30, N31, N34, N35, N36.
-- Report: Figure F7 (cabs, drivers, documents, assignments), Figure F2 (status events), Figure 25, Appendix G.

/* ---------- documents with expiry dates (ID-65, ID-66) ---------- */
CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type  text NOT NULL CHECK (owner_type IN ('cab', 'driver')),
  owner_id    uuid NOT NULL,
  doc_type    text NOT NULL CHECK (doc_type IN ('phv_driver_licence', 'driving_licence', 'phv_vehicle_licence', 'insurance', 'mot')),
  reference   text,
  expires_on  date NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id, doc_type)
);
CREATE INDEX documents_owner_idx ON documents(owner_type, owner_id);
CREATE INDEX documents_expiry_idx ON documents(expires_on);

INSERT INTO documents (owner_type, owner_id, doc_type, reference, expires_on)
  SELECT 'cab', c.id, t.doc, upper(substr(md5(c.id::text || t.doc), 1, 8)), (now() + interval '9 months')::date
    FROM cabs c CROSS JOIN (VALUES ('phv_vehicle_licence'), ('insurance'), ('mot')) AS t(doc);
INSERT INTO documents (owner_type, owner_id, doc_type, reference, expires_on)
  SELECT 'driver', d.id, t.doc, upper(substr(md5(d.id::text || t.doc), 1, 8)), (now() + interval '14 months')::date
    FROM drivers d CROSS JOIN (VALUES ('phv_driver_licence'), ('driving_licence')) AS t(doc);

/* ---------- drivers sign in to the simulated Driver view (N34) ---------- */
ALTER TABLE drivers ADD COLUMN user_id uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL;

/* ---------- Figure F7 ASSIGNMENT and Figure F2 STATUS_EVENT ---------- */
CREATE TABLE assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  cab_id         uuid NOT NULL REFERENCES cabs(id),
  driver_id      uuid NOT NULL REFERENCES drivers(id),
  dispatched_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  end_reason     text
);
CREATE INDEX assignments_booking_idx ON assignments(booking_id, assigned_at);
INSERT INTO assignments (booking_id, cab_id, driver_id, assigned_at)
  SELECT id, cab_id, driver_id, updated_at FROM bookings WHERE driver_id IS NOT NULL;

CREATE TABLE status_events (
  id          bigserial PRIMARY KEY,
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  status      text NOT NULL,
  reason      text,
  by_user     uuid REFERENCES users(id) ON DELETE SET NULL,
  by_role     text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX status_events_booking_idx ON status_events(booking_id, at);
INSERT INTO status_events (booking_id, status, at) SELECT id, status, updated_at FROM bookings;

ALTER TABLE bookings
  ADD COLUMN arrived_at          timestamptz,     -- N18: 10 minutes of free waiting starts here
  ADD COLUMN picked_up_at        timestamptz,
  ADD COLUMN completed_at        timestamptz,
  ADD COLUMN late_minutes        int,             -- ID-45: driver running late; more than 15 = free cancellation
  ADD COLUMN interrupted_reason  text,            -- N30
  ADD COLUMN dispatched_by       uuid REFERENCES users(id) ON DELETE SET NULL;  -- TfL: who dispatched the car

/* ---------- refunds and extra charges carry a reason and who did them (N27, N31) ---------- */
ALTER TABLE payments
  ADD COLUMN reason      text,
  ADD COLUMN created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN approved_by uuid REFERENCES users(id) ON DELETE SET NULL,   -- Figure F3 REFUND.approved_by
  ADD COLUMN charge_kind text CHECK (charge_kind IN ('fare', 'difference', 'cleaning', 'damage', 'late_cancellation', 'no_show', 'other'));

INSERT INTO settings (key, value, description) VALUES
  ('no_show_wait_minutes', '10', 'N18: free waiting time before a no-show can be recorded'),
  ('late_cancel_fee_pct',  '50', 'N18: share of the fare kept when staff cancel late (inside 24 hours) for a customer'),
  ('driver_late_minutes',  '15', 'ID-45: a driver later than this lets the customer cancel free of charge')
ON CONFLICT (key) DO NOTHING;
