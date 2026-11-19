-- Backlog v3, Epics "Support", "Enquiries" and privacy stories: ID-16, ID-22, ID-60, N05, N14, N23, N24, N28, N29, N33.
-- Report: Figure F6 (lost items, complaints), Appendix G.1 (lost property statuses), Table 13 (UK GDPR, TfL).

/* ---------- N23, N28: lost property (Appendix G.1) ---------- */
CREATE TABLE lost_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid REFERENCES bookings(id) ON DELETE SET NULL,
  customer_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('reported', 'found')),
  description   text NOT NULL,
  colour        text,
  contact_pref  text CHECK (contact_pref IN ('email', 'text', 'phone')),
  status        text NOT NULL DEFAULT 'reported'
                CHECK (status IN ('reported', 'searching', 'found', 'ready', 'sent', 'returned', 'not_found')),
  matched_with  uuid REFERENCES lost_items(id) ON DELETE SET NULL,
  logged_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lost_items_booking_idx ON lost_items(booking_id);
CREATE INDEX lost_items_open_idx ON lost_items(status, created_at DESC);

/* ---------- N24, N33: complaints, answered within 5 working days ---------- */
CREATE TABLE complaints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid REFERENCES bookings(id) ON DELETE SET NULL,
  customer_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  driver_id     uuid REFERENCES drivers(id) ON DELETE SET NULL,
  category      text NOT NULL CHECK (category IN ('driver', 'vehicle', 'route', 'price', 'accessibility', 'safety', 'other')),
  text          text NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  due_by        timestamptz NOT NULL,
  answer        text,
  answered_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  answered_at   timestamptz,
  driver_action text,                                     -- N33: what the Manager did about the driver
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX complaints_status_idx ON complaints(status, due_by);

/* ---------- ID-22: favourite places ---------- */
CREATE TABLE favourite_places (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       text NOT NULL,
  address     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, label)
);

/* ---------- ID-60: staff can hide abusive review text ---------- */
ALTER TABLE reviews
  ADD COLUMN hidden        boolean NOT NULL DEFAULT false,
  ADD COLUMN hidden_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN hidden_reason text;

/* ---------- ID-16, N05: personal data requests and deletion ---------- */
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
CREATE TABLE data_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('export', 'delete')),
  status        text NOT NULL DEFAULT 'done' CHECK (status IN ('open', 'done')),
  due_by        timestamptz NOT NULL DEFAULT (now() + interval '1 month'),   -- ICO: answered within one month
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
