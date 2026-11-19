import { query } from '../db.js';

/** Minutes a cab and driver stay blocked after a journey ends (turnaround / positioning time). */
export const BUFFER_MINUTES = 20;

const MS = 60_000;

/** Time window a booking occupies: pickup .. pickup + journey duration + buffer. */
export function bookingWindow(pickupAt, durationMinutes) {
  const start = new Date(pickupAt);
  const end = new Date(start.getTime() + (durationMinutes + BUFFER_MINUTES) * MS);
  return { start, end };
}

/**
 * Cabs of an (optional) size that are active and have no non-cancelled booking overlapping [start, end).
 * `db` may be the pool or a transaction client. `excludeBookingId` lets an amendment ignore its own booking.
 */
export async function findAvailableCabs(db, { start, end, sizeCode = null, excludeBookingId = null }) {
  const run = db?.query ? db.query.bind(db) : query;
  const { rows } = await run(
    `SELECT c.*, s.label AS size_label, s.seats
       FROM cabs c JOIN cab_sizes s ON s.code = c.size_code
      WHERE c.active
        AND ($3::text IS NULL OR c.size_code = $3)
        AND NOT EXISTS (
          SELECT 1 FROM bookings b
           WHERE b.cab_id = c.id AND b.status <> 'cancelled'
             AND ($4::uuid IS NULL OR b.id <> $4)
             AND tstzrange(b.pickup_at, b.end_at) && tstzrange($1::timestamptz, $2::timestamptz))
      ORDER BY s.seats, c.reg`,
    [start, end, sizeCode, excludeBookingId],
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
           WHERE b.driver_id = d.id AND b.status <> 'cancelled'
             AND ($3::uuid IS NULL OR b.id <> $3)
             AND tstzrange(b.pickup_at, b.end_at) && tstzrange($1::timestamptz, $2::timestamptz))
      ORDER BY d.full_name`,
    [start, end, excludeBookingId],
  );
  return rows;
}

/** Counts per size so the booking screen can disable sizes that are fully booked (US3.3 / US5.1). */
export async function availabilityBySize(db, { start, end, excludeBookingId = null }) {
  const cabs = await findAvailableCabs(db, { start, end, excludeBookingId });
  const out = {};
  for (const c of cabs) out[c.size_code] = (out[c.size_code] || 0) + 1;
  return out;
}
