-- Backlog v3, Epic "Accounts and Access": ID-11, ID-12, ID-13, ID-15, ID-18, ID-20, N01, N02, N03, N04.
-- Report: Table 7 (actors), Appendix D (access matrix), Figure F1 (users, customer profile, staff member, audit log).

-- Eight actors. Customer, Business Booker and Business Account Admin share the 'customer' role (company membership
-- decides the rest); Manager inherits Call Centre Staff; Admin and Driver stand alone.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('customer', 'staff', 'manager', 'admin', 'driver'));

ALTER TABLE users
  ADD COLUMN email_verified     boolean NOT NULL DEFAULT false,   -- ID-11: verified before the first booking
  ADD COLUMN marketing_consent  boolean NOT NULL DEFAULT false,   -- ID-15, ID-72: offers only to opted-in customers
  ADD COLUMN secret_word_hash   text,                             -- ID-20: caller verification, never printed on receipts
  ADD COLUMN failed_logins      int NOT NULL DEFAULT 0,           -- ID-13
  ADD COLUMN locked_until       timestamptz,                      -- ID-13
  ADD COLUMN refund_limit       numeric(8,2),                     -- N27: staff limit per booking per day (NULL = no limit)
  ADD COLUMN last_login_at      timestamptz;

-- Accounts that existed before email verification are treated as verified.
UPDATE users SET email_verified = true;

-- ID-13: server-side sessions. The browser holds the id in an HttpOnly cookie; apps send it as a Bearer token.
-- Only a SHA-256 hash of the session id is stored. A session ends after 30 minutes without activity.
CREATE TABLE sessions (
  id_hash       text PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,                -- absolute limit (12 hours)
  ip            text,
  user_agent    text,
  revoked_at    timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id) WHERE revoked_at IS NULL;

-- ID-13: every login attempt, used for the lockout by account and IP address (5 failures in 15 minutes).
CREATE TABLE login_attempts (
  id       bigserial PRIMARY KEY,
  email    citext NOT NULL,
  ip       text NOT NULL,
  success  boolean NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_lookup ON login_attempts(email, ip, at DESC);
CREATE INDEX login_attempts_ip ON login_attempts(ip, at DESC);

-- One-time email links: verify an address (ID-11), unlock an account (ID-13), confirm an email change (ID-15).
CREATE TABLE email_tokens (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify', 'unlock')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_user_idx ON email_tokens(user_id, purpose);

-- N03 + Definition of Done line 9: every booking, dispatch, refund and record view stores who did it and when.
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  staff_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  staff_name   text,
  staff_role   text,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_at_idx ON audit_log(at DESC);
CREATE INDEX audit_log_staff_idx ON audit_log(staff_id, at DESC);
CREATE INDEX audit_log_target_idx ON audit_log(target_type, target_id);

-- N29: notes staff add to a customer account.
CREATE TABLE customer_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  staff_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_notes_idx ON customer_notes(customer_id, created_at DESC);

-- N04: settings the Admin can change.
INSERT INTO settings (key, value, description) VALUES
  ('staff_refund_limit',     '50', 'N27: refund limit for Call Centre Staff, per booking per day (GBP)'),
  ('session_idle_minutes',   '30', 'ID-13: a session ends after this many minutes without activity'),
  ('lockout_failures',       '5',  'ID-13: failed logins (same account and IP) before a lock'),
  ('lockout_minutes',        '15', 'ID-13: lock length and counting window, in minutes'),
  ('retention_months',       '12', 'N05: personal data and records are kept this many months (TfL)')
ON CONFLICT (key) DO NOTHING;

UPDATE users SET refund_limit = 50 WHERE role = 'staff';
