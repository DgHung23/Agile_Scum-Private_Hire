import { query } from '../db.js';

/** Minutes a cab and driver stay blocked after a journey ends (turnaround / positioning time). */
export const BUFFER_MINUTES = 20;

/** Booking states that no longer hold a cab or driver (report Figure 25). Used in SQL as `status NOT IN ...`. */
export const RELEASED = "('cancelled','company_cancelled','abandoned')";
/** Booking states that count as real trips for spend, loyalty and reports. */
export const NOT_TRIP = "('cancelled','company_cancelled','abandoned','pending_payment')";

const MS = 60_000;

/** Time window a booking occupies: pickup .. pickup + journey duration + buffer. */
export function bookingWindow(pickupAt, durationMinutes) {
  const start = new Date(pickupAt);
  const end = new Date(start.getTime() + (durationMinutes + BUFFER_MINUTES) * MS);
  return { start, end };
}

/**
 * Release cabs held by bookings that never completed payment (ID-53: the hold lasts 15 minutes).
 * Runs before every availability check, and every minute in the background.
 */
export async function expireHolds(db) {
  const run = db?.query ? db.query.bind(db) : query;
  const { rows } = await run(
    `UPDATE bookings SET status='abandoned', updated_at=now()
      WHERE status='pending_payment' AND hold_expires_at < now() RETURNING id`,
  );
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    await run('DELETE FROM coupon_redemptions WHERE booking_id = ANY($1)', [ids]); // the coupon goes back to the wallet
    await run('DELETE FROM applied_discounts WHERE booking_id = ANY($1) AND kind = $2', [ids, 'coupon']);
  }
  return rows.length;
}

/**
 * Cabs of an (optional) size that are available and have no holding booking overlapping [start, end).
 * `wheelchair` keeps only wheelchair-accessible cabs (ID-39). An Unavailable cab can never be offered (ID-65).
 * `db` may be the pool or a transaction client. `excludeBookingId` lets an amendment ignore its own booking.
 */
export async function findAvailableCabs(db, { start, end, sizeCode = null, excludeBookingId = null, wheelchair = false }) {
  const run = db?.query ? db.query.bind(db) : query;
  const { rows } = await run(
    `SELECT c.*, s.label AS size_label, s.seats
       FROM cabs c JOIN cab_sizes s ON s.code = c.size_code
      WHERE c.active AND c.status = 'available'
        AND ($3::text IS NULL OR c.size_code = $3)
        AND (NOT $5::boolean OR c.wheelchair_accessible)
        AND NOT EXISTS (
          SELECT 1 FROM bookings b
           WHERE b.cab_id = c.id AND b.status NOT IN ${RELEASED}
             AND ($4::uuid IS NULL OR b.id <> $4)
             AND tstzrange(b.pickup_at, b.end_at) && tstzrange($1::timestamptz, $2::timestamptz))
      ORDER BY s.seats, c.wheelchair_accessible, c.reg`,
    [start, end, sizeCode, excludeBookingId, !!wheelchair],
  );
  return rows;
}

export async function findAvailableDrivers(db, { start, end, excludeBookingId = null }) {
  const run = db?.query ? db.query.bind(db) : query;
  const { rows } = await run(
    `SELECT d.*
       FROM drivers d
      WHERE d.active
        AND NOT EXISTS (
          SELECT 1 FROM bookings b
           WHERE b.driver_id = d.id AND b.status NOT IN ${RELEASED}
             AND ($3::uuid IS NULL OR b.id <> $3)
             AND tstzrange(b.pickup_at, b.end_at) && tstzrange($1::timestamptz, $2::timestamptz))
      ORDER BY d.full_name`,
    [start, end, excludeBookingId],
  );
  return rows;
}

/** Counts per size so the booking screen can disable sizes that are fully booked (ID-48). */
export async function availabilityBySize(db, { start, end, excludeBookingId = null, wheelchair = false }) {
  const cabs = await findAvailableCabs(db, { start, end, excludeBookingId, wheelchair });
  const out = {};
  for (const c of cabs) out[c.size_code] = (out[c.size_code] || 0) + 1;
  return out;
}
