-- Sprint 2 / Module 6 - cancel and amend (R10)
ALTER TABLE bookings
  ADD COLUMN offer_pct     numeric(5,2) NOT NULL DEFAULT 0,   -- offer % used at booking, re-applied when the booking is amended
  ADD COLUMN amended_at    timestamptz,
  ADD COLUMN amend_count   int NOT NULL DEFAULT 0;
