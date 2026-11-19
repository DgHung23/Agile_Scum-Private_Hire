-- Backlog v3, Epic "Business Accounts": N06 to N12. Report: Section 2.1 (business account flow), Table 8 (unusual
-- cases), Figure F5 (business account states), Figures F4 and F6 (companies, members, invoices, invoice lines).

CREATE TABLE companies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  companies_house_no  text NOT NULL,
  billing_address     text NOT NULL,
  finance_contact     text NOT NULL,
  finance_email       citext NOT NULL,
  account_type        text NOT NULL DEFAULT 'invoice' CHECK (account_type IN ('invoice', 'card')),
  expected_spend      numeric(10,2),
  credit_limit        numeric(10,2),
  -- Figure F5: pending -> approved | rejected; approved -> suspended (15 days overdue) -> approved (paid) | closed
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended', 'closed')),
  status_reason       text,
  applied_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_number_idx ON companies(upper(companies_house_no)) WHERE status IN ('pending', 'approved', 'suspended');

CREATE TABLE company_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role  text NOT NULL CHECK (member_role IN ('admin', 'booker')),
  active       boolean NOT NULL DEFAULT true,
  added_at     timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  UNIQUE (company_id, customer_id)
);
-- A person books for one company at a time.
CREATE UNIQUE INDEX company_members_one_active ON company_members(customer_id) WHERE active;

CREATE TABLE company_invites (
  token_hash   text PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email        citext NOT NULL,
  invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bookings
  ADD COLUMN company_id  uuid REFERENCES companies(id) ON DELETE SET NULL,   -- N09
  ADD COLUMN cost_centre text;                                               -- N09, shown on the receipt
CREATE INDEX bookings_company_idx ON bookings(company_id, pickup_at);

CREATE TABLE invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           text NOT NULL UNIQUE,
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  due_on           date NOT NULL,                       -- 15 days after issue (Addison Lee terms in the report)
  total            numeric(10,2) NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'overdue')),
  paid_at          timestamptz,
  reminders_sent   int NOT NULL DEFAULT 0,
  last_reminder_at timestamptz
);
CREATE INDEX invoices_company_idx ON invoices(company_id, issued_at DESC);

CREATE TABLE invoice_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  booking_id  uuid UNIQUE REFERENCES bookings(id) ON DELETE SET NULL,   -- a booking is billed once
  amount      numeric(10,2) NOT NULL
);
