import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { driverOnly } from '../middleware/auth.js';
import { body, wrap } from '../middleware/validate.js';
import { HttpError, notFound } from '../errors.js';
import { audit } from '../services/audit.js';
import { ACCESSIBILITY_LABEL, loadBookingRow } from '../services/booking.js';
import { changeStatus, reportLate } from '../services/journey.js';
import { logFoundItem } from './support.js';

/**
 * Simulated Driver view (team decision 19 Nov; N34, N35, N36). A driver sees only their own jobs and only the job
 * details (access matrix: "Own jobs, status"). Each button triggers the customer's texts, the receipt and the review.
 */
export const router = Router();
router.use(...driverOnly);

async function me(req) {
  const { rows } = await query('SELECT * FROM drivers WHERE user_id=$1 AND active', [req.user.id]);
  if (!rows[0]) throw new HttpError(403, 'This account is not linked to a driver. Ask an Admin.', 'no_driver');
  return rows[0];
}

const job = (b) => ({
  id: b.id,
  ref: b.ref,
  status: b.status,
  pickupAt: b.pickup_at,
  pickup: b.pickup,
  destination: b.destination,
  service: b.service_label,
  package: b.package_label,
  passengers: b.passengers,
  luggage: b.luggage,
  childSeatAges: b.child_seat_ages || [],
  pet: b.pet,
  accessibility: (b.accessibility || []).map((a) => ACCESSIBILITY_LABEL[a]),
  flightNo: b.flight_no,
  noteToDriver: b.note_to_driver,
  // job details only: the passenger's first name and a phone to call at pickup
  passengerFirstName: (b.passenger_name || b.customer_name).split(' ')[0],
  contactPhone: b.passenger_phone || b.notify_phone || b.customer_phone,
  vehicle: { reg: b.cab_reg, make: b.cab_make, model: b.cab_model, colour: b.cab_colour },
  etaMinutes: b.eta_minutes,
  arrivedAt: b.arrived_at,
  lateMinutes: b.late_minutes,
  payOnCompletion: b.payment_status === 'due_cash' ? Number(b.total) : null,
});

/** N34: my jobs, today and upcoming, plus what I finished today. */
router.get(
  '/jobs',
  wrap(async (req, res) => {
    const d = await me(req);
    const { rows } = await query(
      `SELECT id FROM bookings
        WHERE driver_id=$1 AND (status IN ('assigned','on_route','arrived','in_progress','interrupted')
              OR (status IN ('completed','no_show') AND (updated_at AT TIME ZONE 'Europe/London')::date = (now() AT TIME ZONE 'Europe/London')::date))
        ORDER BY pickup_at LIMIT 50`,
      [d.id],
    );
    const jobs = [];
    for (const r of rows) jobs.push(job(await loadBookingRow(null, r.id)));
    res.json({ driver: { name: d.full_name, licenceNo: d.licence_no }, jobs });
  }),
);

async function myJob(db, req) {
  if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Job not found');
  const d = await me(req);
  const row = await loadBookingRow(db, req.params.id);
  if (!row || row.driver_id !== d.id) throw notFound('Job not found');
  return row;
}

/** N35: Arrived / Picked up / Completed (and "On my way" with an ETA). Follows the same rules as staff (ID-68). */
router.post(
  '/jobs/:id/status',
  body(z.object({
    status: z.enum(['on_route', 'arrived', 'in_progress', 'completed', 'no_show']),
    etaMinutes: z.coerce.number().int().min(1).max(120).optional(),
    cashCollected: z.boolean().optional(),
  })),
  wrap(async (req, res) => {
    const out = await tx(async (db) => {
      const row = await myJob(db, req);
      if (req.body.status === 'completed' && row.payment_status === 'due_cash' && !req.body.cashCollected) {
        throw new HttpError(400, `Collect ${Number(row.total).toFixed(2)} in cash before completing the job.`, 'cash_due');
      }
      return changeStatus(db, { id: row.id, to: req.body.status, actor: req.user, req, etaMinutes: req.body.etaMinutes, cashCollected: !!req.body.cashCollected, byDriver: true });
    });
    res.json({ job: job(out.row), sent: out.sent });
  }),
);

router.post(
  '/jobs/:id/late',
  body(z.object({ minutes: z.coerce.number().int().min(1).max(180) })),
  wrap(async (req, res) => {
    const out = await tx(async (db) => {
      const row = await myJob(db, req);
      return reportLate(db, { id: row.id, minutes: req.body.minutes, actor: req.user, req });
    });
    res.json({ job: job(out.row) });
  }),
);

/** N36: report a breakdown (the journey becomes Interrupted) or a found item (logged on the booking). */
router.post(
  '/jobs/:id/report',
  body(z.object({ kind: z.enum(['breakdown', 'found_item']), message: z.string({ error: 'Describe it' }).trim().min(3, 'Describe it').max(300) })),
  wrap(async (req, res) => {
    const out = await tx(async (db) => {
      const row = await myJob(db, req);
      if (req.body.kind === 'breakdown') {
        return (await changeStatus(db, { id: row.id, to: 'interrupted', actor: req.user, req, reason: req.body.message, byDriver: true })).row;
      }
      await db.query("INSERT INTO incidents (booking_id, reported_by, kind, message) VALUES ($1,$2,'found_item',$3)", [row.id, req.user.id, req.body.message]);
      await logFoundItem(db, { bookingId: row.id, description: req.body.message, actor: req.user }); // N28: matched to a report
      await audit(db, req, 'driver.found_item', 'booking', row.id, { message: req.body.message });
      return loadBookingRow(db, row.id);
    });
    res.status(201).json({ job: job(out) });
  }),
);
