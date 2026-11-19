-- Sprint 1 / Module 2 - accounts and the notification outbox
-- Email and SMS are simulated: every message is stored here and shown in the app ("Messages" / staff outbox).
-- A real provider (SendGrid, Twilio...) would be called from server/src/services/notify.js.

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  channel     text NOT NULL CHECK (channel IN ('email', 'sms')),
  to_addr     text NOT NULL,
  subject     text,
  body        text NOT NULL,
  kind        text NOT NULL DEFAULT 'general',
  booking_id  uuid,
  sent_by     uuid REFERENCES users(id),
  status      text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX notifications_created_idx ON notifications(created_at DESC);
