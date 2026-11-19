-- Sprint 3 / Module 7 - call centre: caller verification audit (R11)
-- Staff must pass a verification check before an existing customer's account opens. Every attempt is recorded.
CREATE TABLE caller_verifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id     uuid NOT NULL REFERENCES users(id),
  customer_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  methods      text[] NOT NULL DEFAULT '{}',   -- which answers matched, e.g. {postcode,phone_last4}
  matched      int NOT NULL DEFAULT 0,
  verified     boolean NOT NULL DEFAULT false,
  reason       text,                            -- 'checks_passed' | 'new_account' | 'failed'
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '30 minutes')
);
CREATE INDEX caller_verifications_lookup ON caller_verifications(staff_id, customer_id, verified, expires_at);
CREATE INDEX caller_verifications_failed ON caller_verifications(customer_id, created_at) WHERE NOT verified;
