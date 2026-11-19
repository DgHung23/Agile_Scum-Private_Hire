-- Sprint 1 / Module 1 - core platform tables
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

-- Business rules that can change without a deploy (R3 15% discount, R10 24h window)
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  description text
);

INSERT INTO settings (key, value, description) VALUES
  ('online_discount_pct',  '15', 'R3: discount applied to online bookings only'),
  ('cancel_window_hours',  '24', 'R10: customers may cancel/amend until this many hours before pickup'),
  ('currency',             'GBP', 'Display currency'),
  ('company_name',         'PrivateHire Cars', 'Display name');

-- One table for every person: customers, call-centre staff and managers (admin)
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role           text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'staff', 'admin')),
  email          citext NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  full_name      text NOT NULL,
  phone          text NOT NULL,
  address_line   text,
  city           text,
  postcode       text,
  notify_pref    text NOT NULL DEFAULT 'email' CHECK (notify_pref IN ('email', 'text', 'both')),
  is_active      boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users(id),
  signup_channel text NOT NULL DEFAULT 'online' CHECK (signup_channel IN ('online', 'phone', 'in_person')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_role_idx ON users(role);
CREATE INDEX users_phone_idx ON users(phone);
CREATE INDEX users_name_idx ON users (lower(full_name));
