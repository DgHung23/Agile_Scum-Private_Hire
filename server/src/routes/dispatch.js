import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { staffOnly } from '../middleware/auth.js';
import { body, wrap } from '../middleware/validate.js';
import { HttpError, notFound } from '../errors.js';
import { audit } from '../services/audit.js';
import { findAvailableCabs, findAvailableDrivers } from '../services/availability.js';
import { getSettings, loadBookingRow, serializeBooking } from '../services/booking.js';
import { assignDriver, changeDestination, changeStatus, extraCharge, recordEvent, reportLate, staffRefund } from '../services/journey.js';

export { arrivalSmsText } from '../services/journey.js';

export const router = Router();
router.use(...staffOnly);

const idCheck = (id) => {
  if (!z.string().uuid().safeParse(id).success) throw notFound('Booking not found');
};
const out = async (res, row, extra = {}) => {
  const settings = await getSettings();
  res.json({ booking: serializeBooking(row, { cancelWindowHours: settings.cancelWindowHours, forStaff: true }), ...extra });
};

/** ID-79 dispatch board: what needs a driver (online/priority first), what is assigned, what is on the road. */
router.get(
  '/dispatch',
  wrap(async (_req, res) => {
    const settings = await getSettings();
    const { rows } = await query(
      `SELECT id FROM bookings
        WHERE status IN ('confirmed','assigned','on_route','arrived','in_progress','interrupted')
          AND (end_at >= now() - interval '3 hours' OR status IN ('on_route','arrived','in_progress','interrupted'))
          AND pickup_at < now() + interval '48 hours'
        ORDER BY pickup_at ASC`,
    );
    const full = [];
    for (const r of rows) full.push(serializeBooking(await loadBookingRow(null, r.id), { cancelWindowHours: settings.cancelWindowHours, forStaff: true }));
    const prioritySort = (a, b) => Number(b.priority) - Number(a.priority) || new Date(a.pickupAt) - new Date(b.pickupAt);
    res.json({
      needsDriver: full.filter((b) => b.status === 'confirmed').sort(prioritySort),
      assigned: full.filter((b) => b.status === 'assigned'),
      onRoute: full.filter((b) => ['on_route', 'arrived', 'in_progress'].includes(b.status)),
      interrupted: full.filter((b) => b.status === 'interrupted'),
    });
  }),
);

/** Drivers and cabs that could take this booking (ID-67, ID-58). Expired documents are excluded (ID-65, ID-66). */
router.get(
  '/bookings/:id/options',
  wrap(async (req, res) => {
    idCheck(req.params.id);
    const row = await loadBookingRow(null, req.params.id);
    if (!row) throw notFound('Booking not found');
    const win = { start: row.pickup_at, end: row.end_at, excludeBookingId: row.id };
    const [drivers, cabs] = await Promise.all([
      findAvailableDrivers(null, win),
      findAvailableCabs(null, { ...win, wheelchair: (row.accessibility || []).includes('wheelchair') }),
    ]);
    res.json({
      drivers: drivers.map((d) => ({ id: d.id, fullName: d.full_name, phone: d.phone })),
      cabs: cabs
        .filter((c) => c.seats >= row.passengers)
        .map((c) => ({ id: c.id, reg: c.reg, make: c.make, model: c.model, colour: c.colour, sizeCode: c.size_code, sizeLabel: c.size_label, seats: c.seats, wheelchairAccessible: c.wheelchair_accessible, current: c.id === row.cab_id })),
    });
  }),
);

const assignSchema = z.object({
  driverId: z.string({ error: 'Choose a driver' }).uuid('Choose a driver'),
  cabId: z.string().uuid().optional(),
});

/** ID-67 assign a free driver; N30 the same call sends a replacement car for an interrupted journey. */
router.post(
  '/bookings/:id/assign',
  body(assignSchema),
  wrap(async (req, res) => {
    idCheck(req.params.id);
    const r = await tx((db) => assignDriver(db, { id: req.params.id, driverId: req.body.driverId, cabId: req.body.cabId || null, actor: req.user, req }));
    await out(res, r.row, { sent: r.sent });
  }),
);

router.post(
  '/bookings/:id/unassign',
  wrap(async (req, res) => {
    idCheck(req.params.id);
    const row = await tx(async (db) => {
      const r = await db.query("UPDATE bookings SET driver_id=NULL, status='confirmed', eta_minutes=NULL, updated_at=now() WHERE id=$1 AND status='assigned' RETURNING id", [req.params.id]);
      if (!r.rowCount) throw new HttpError(409, 'Only an assigned booking that has not started can be unassigned.', 'bad_status');
      await db.query("UPDATE assignments SET ended_at=now(), end_reason='unassigned' WHERE booking_id=$1 AND ended_at IS NULL", [req.params.id]);
      await recordEvent(db, req.params.id, 'confirmed', req.user, 'driver unassigned');
      await audit(db, req, 'dispatch.unassign', 'booking', req.params.id);
      return loadBookingRow(db, req.params.id);
    });
    await out(res, row);
  }),
);

const statusSchema = z.object({
  status: z.enum(['on_route', 'arrived', 'in_progress', 'completed', 'no_show', 'interrupted'], { error: 'Choose a status' }),
  etaMinutes: z.coerce.number().int().min(1, 'ETA must be at least 1 minute').max(120, 'ETA must be 120 minutes or less').optional(),
  reason: z.string().trim().max(300).optional(),
  cashCollected: z.boolean().optional(),
});

/**
 * ID-68 update a journey's status (report Figure 25). On route with an ETA of 15 minutes or less texts the customer
 * the car's registration, colour and make (once) when they chose text updates (ID-45).
 */
router.post(
  '/bookings/:id/status',
  body(statusSchema),
  wrap(async (req, res) => {
    idCheck(req.params.id);
    const r = await tx((db) =>
      changeStatus(db, { id: req.params.id, to: req.body.status, actor: req.user, req, etaMinutes: req.body.etaMinutes, reason: req.body.reason, cashCollected: req.body.cashCollected }),
    );
    await out(res, r.row, { sent: r.sent });
  }),
);

/** ID-45: the driver is running late (new arrival time by text). */
router.post(
  '/bookings/:id/late',
  body(z.object({ minutes: z.coerce.number({ error: 'Enter the delay in minutes' }).int().min(1).max(180) })),
  wrap(async (req, res) => {
    idCheck(req.params.id);
    const r = await tx((db) => reportLate(db, { id: req.params.id, minutes: req.body.minutes, actor: req.user, req }));
    await out(res, r.row, { sent: r.sent });
  }),
);

/** N27: refund up to the staff limit per booking per day (Manager: any amount). */
router.post(
  '/bookings/:id/refund',
  body(z.object({
    amount: z.coerce.number({ error: 'Enter an amount' }).positive('Enter an amount above zero').max(5000),
    reason: z.string({ error: 'Give a reason' }).trim().min(3, 'Give a reason').max(300),
  })),
  wrap(async (req, res) => {
    idCheck(req.params.id);
    const r = await tx((db) => staffRefund(db, { id: req.params.id, amount: Math.round(req.body.amount * 100) / 100, reason: req.body.reason, actor: req.user, req }));
    await out(res, r.row, { refund: { id: r.refund.id, amount: r.refund.amount } });
  }),
);

/** N31 cleaning or damage charge; N18 no-show or late-cancellation charge. Always with a reason the customer sees. */
router.post(
  '/bookings/:id/charge',
  body(z.object({
    amount: z.coerce.number({ error: 'Enter an amount' }).positive('Enter an amount above zero').max(500),
    kind: z.enum(['cleaning', 'damage', 'late_cancellation', 'no_show', 'other']),
    reason: z.string({ error: 'Give a reason' }).trim().min(3, 'Give a reason').max(300),
  })),
  wrap(async (req, res) => {
    idCheck(req.params.id);
    const r = await tx((db) => extraCharge(db, { id: req.params.id, amount: Math.round(req.body.amount * 100) / 100, kind: req.body.kind, reason: req.body.reason, actor: req.user, req }));
    await out(res, r.row, { charge: { id: r.payment.id, amount: r.payment.amount } });
  }),
);

/** N26: change the destination during the journey; the price is recalculated. */
router.post(
  '/bookings/:id/destination',
  body(z.object({ destination: z.string({ error: 'Enter the new destination' }).trim().min(2, 'Enter the new destination').max(200) })),
  wrap(async (req, res) => {
    idCheck(req.params.id);
    const r = await tx((db) => changeDestination(db, { id: req.params.id, destination: req.body.destination, actor: req.user, req }));
    await out(res, r.row, { difference: r.difference });
  }),
);

/** Figure F2: the booking's status events and assignments, with who did what. */
router.get(
  '/bookings/:id/history',
  wrap(async (req, res) => {
    idCheck(req.params.id);
    const [events, assigns] = await Promise.all([
      query(
        `SELECT e.*, u.full_name FROM status_events e LEFT JOIN users u ON u.id = e.by_user WHERE e.booking_id=$1 ORDER BY e.at, e.id`,
        [req.params.id],
      ),
      query(
        `SELECT a.*, c.reg, d.full_name AS driver_name, u.full_name AS dispatcher
           FROM assignments a JOIN cabs c ON c.id = a.cab_id JOIN drivers d ON d.id = a.driver_id LEFT JOIN users u ON u.id = a.dispatched_by
          WHERE a.booking_id=$1 ORDER BY a.assigned_at`,
        [req.params.id],
      ),
    ]);
    res.json({
      events: events.rows.map((e) => ({ id: e.id, status: e.status, reason: e.reason, by: e.full_name, role: e.by_role, details: e.details, at: e.at })),
      assignments: assigns.rows.map((a) => ({ id: a.id, reg: a.reg, driver: a.driver_name, dispatchedBy: a.dispatcher, assignedAt: a.assigned_at, endedAt: a.ended_at, endReason: a.end_reason })),
    });
  }),
);

/** Staff home: today's numbers and the next priority (online) bookings. */
router.get(
  '/dashboard',
  wrap(async (_req, res) => {
    const settings = await getSettings();
    const stats = (
      await query(
        `SELECT
           count(*) FILTER (WHERE (pickup_at AT TIME ZONE 'Europe/London')::date = (now() AT TIME ZONE 'Europe/London')::date AND status NOT IN ('cancelled','company_cancelled','abandoned'))::int AS today,
           count(*) FILTER (WHERE status = 'confirmed' AND end_at >= now())::int AS needs_driver,
           count(*) FILTER (WHERE status = 'on_route')::int AS on_route,
           count(*) FILTER (WHERE priority AND status IN ('confirmed','assigned') AND end_at >= now())::int AS priority_open
         FROM bookings`,
      )
    ).rows[0];
    const enquiries = (await query("SELECT count(*)::int AS n FROM enquiries WHERE status='new'")).rows[0].n;
    // ID-44: failed messages are shown to staff; N20/N22: open incidents need attention first.
    const failedMessages = (await query("SELECT count(*)::int AS n FROM notifications WHERE status='failed' AND created_at > now() - interval '7 days'")).rows[0].n;
    const openIncidents = (await query("SELECT count(*)::int AS n FROM incidents WHERE status='open'")).rows[0].n;
    const { rows } = await query(
      `SELECT id FROM bookings WHERE status IN ('confirmed','assigned') AND end_at >= now()
        ORDER BY priority DESC, pickup_at ASC LIMIT 6`,
    );
    const next = [];
    for (const r of rows) next.push(serializeBooking(await loadBookingRow(null, r.id), { cancelWindowHours: settings.cancelWindowHours, forStaff: true }));
    res.json({ stats: { today: stats.today, needsDriver: stats.needs_driver, onRoute: stats.on_route, priorityOpen: stats.priority_open, newEnquiries: enquiries, failedMessages, openIncidents }, next });
  }),
);
