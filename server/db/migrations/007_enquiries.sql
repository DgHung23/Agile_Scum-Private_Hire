-- Sprint 3 / Module 8 - enquiries (R2), staff replies (R13)
CREATE TABLE enquiries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,   -- NULL for visitors who are not registered
  name        text NOT NULL,
  email       citext NOT NULL,
  subject     text NOT NULL,
  message     text NOT NULL,
  booking_id  uuid REFERENCES bookings(id) ON DELETE SET NULL, -- set for "enquiry about a specific trip"
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'replied')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  replied_at  timestamptz
);
CREATE INDEX enquiries_status_idx ON enquiries(status, created_at DESC);
CREATE INDEX enquiries_user_idx ON enquiries(user_id, created_at DESC);

CREATE TABLE enquiry_replies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id  uuid NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  staff_id    uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX enquiry_replies_idx ON enquiry_replies(enquiry_id, created_at);
