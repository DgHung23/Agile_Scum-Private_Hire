import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { staffOnly } from '../middleware/auth.js';
import { body, wrap } from '../middleware/validate.js';
import { HttpError, badRequest, notFound } from '../errors.js';
import { findAvailableCabs, findAvailableDrivers } from '../services/availability.js';
import { getSettings, loadBookingRow, serializeBooking } from '../services/booking.js';
import { sendEmail, sendSms } from '../services/notify.js';

export const router = Router();
router.use(...staffOnly);

const idCheck = (id) => {
  if (!z.string().uuid().safeParse(id).success) throw notFound('Booking not found');
};

/** The text sent when the driver is near (R6, US4.3). Includes registration, colour and make. */
export function arrivalSmsText(b, eta) {
  const first = (b.driver_name || 'Your driver').split(' ')[0];
  return `Private Hire: ${first} is about ${eta} min away. Look for a ${b.cab_colour} ${b.cab_make} ${b.cab_model}, reg ${b.cab_reg}. Booking ${b.ref}. Check the reg before you get in.`;
}

/** Dispatch board: what needs a driver (online/priority first), what is assigned, what is on the road. */
router.get(
  '/dispatch',
  wrap(async (_req, res) => {
    const settings = await getSettings();
    const { rows } = await query(
      `SELECT id, status, priority, pickup_at FROM bookings
        WHERE status IN ('confirmed','assigned','on_route')
          AND (end_at >= now() - interval '2 hours')
          AND pickup_at < now() + interval '48 hours'
        ORDER BY pickup_at ASC`,
    );
    const full = [];
    for (const r of rows) full.push(serializeBooking(await loadBookingRow(null, r.id), { cancelWindowHours: settings.cancelWindowHours, forStaff: true }));
    const prioritySort = (a, b) => Number(b.priority) - Number(a.priority) || new Date(a.pickupAt) - new Date(b.pickupAt);
    res.json({
      needsDriver: full.filter((b) => b.status === 'confirmed').sort(prioritySort),
      assigned: full.filter((b) => b.status === 'assigned'),
      onRoute: full.filter((b) => b.status === 'on_route'),
    });
  }),
);

/** Drivers and cabs that could take this booking (US9.9). */
router.get(
  '/bookings/:id/options',
  wrap(async (req, res) => {
    idCheck(req.params.id);
    const row = await loadBookingRow(null, req.params.id);
    if (!row) throw notFound('Booking not found');
    const win = { start: row.pickup_at, end: row.end_at, excludeBookingId: row.id };
    const [drivers, cabs] = await Promise.all([findAvailableDrivers(null, win), findAvailableCabs(null, win)]);
    res.json({
      drivers: drivers.map((d) => ({ id: d.id, fullName: d.full_name, phone: d.phone })),
      cabs: cabs
        .filter((c) => c.seats >= row.passengers)
        .map((c) => ({ id: c.id, reg: c.reg, make: c.make, model: c.model, colour: c.colour, sizeLabel: c.size_label, seats: c.seats, current: c.id === row.cab_id })),
    });
  }),
);

const assignSchema = z.object({
  driverId: z.string({ error: 'Choose a driver' }).uuid('Choose a driver'),
  cabId: z.string().uuid().optional(),
});

router.post(
  '/bookings/:id/assign',
  body(assignSchema),
  wrap(async (req, res) => {
    idCheck(req.params.id);
    const out = await tx(async (db) => {
      const lock = await db.query('SELECT status FROM bookings WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!lock.rowCount) throw notFound('Booking not found');
      const row = await loadBookingRow(db, req.params.id);
      if (!['confirmed', 'assigned'].includes(row.status)) {
        throw new HttpError(409, `A ${row.status.replace('_', ' ')} booking cannot be assigned.`, 'bad_status');
      }
      const win = { start: row.pickup_at, end: row.end_at, excludeBookingId: row.id };
      const drivers = await findAvailableDrivers(db, win);
      if (!drivers.find((d) => d.id === req.body.driverId)) {
        throw new HttpError(409, 'That driver is not free for this journey. Choose another driver.', 'driver_busy');
      }
      let cabId = row.cab_id;
      if (req.body.cabId && req.body.cabId !== row.cab_id) {
        const cabs = await findAvailableCabs(db, win);
        const cab = cabs.find((c) => c.id === req.body.cabId);
        if (!cab) throw new HttpError(409, 'That cab is not free for this journey.', 'cab_busy');
        if (cab.seats < row.passengers) throw badRequest('That cab is too small for the passengers', { cabId: 'Too small for the passengers' });
        cabId = cab.id;
      }
      await db.query("UPDATE bookings SET driver_id=$2, cab_id=$3, status='assigned', updated_at=now() WHERE id=$1", [row.id, req.body.driverId, cabId]);
      return loadBookingRow(db, row.id);
    });
    const settings = await getSettings();
    res.json({ booking: serializeBooking(out, { cancelWindowHours: settings.cancelWindowHours, forStaff: true }) });
  }),
);

router.post(
  '/bookings/:id/unassign',
  wrap(async (req, res) => {
    idCheck(req.params.id);
    const r = await query("UPDATE bookings SET driver_id=NULL, status='confirmed', eta_minutes=NULL, updated_at=now() WHERE id=$1 AND status='assigned' RETURNING id", [req.params.id]);
    if (!r.rowCount) throw new HttpError(409, 'Only an assigned booking that has not started can be unassigned.', 'bad_status');
    const settings = await getSettings();
    res.json({ booking: serializeBooking(await loadBookingRow(null, req.params.id), { cancelWindowHours: settings.cancelWindowHours, forStaff: true }) });
  }),
);

const statusSchema = z.object({
  status: z.enum(['on_route', 'completed', 'assigned'], { error: 'Choose a status' }),
  etaMinutes: z.coerce.number().int().min(1, 'ETA must be at least 1 minute').max(120, 'ETA must be 120 minutes or less').optional(),
});

const TRANSITIONS = {
  on_route: ['assigned', 'on_route'],
  completed: ['assigned', 'on_route'],
  assigned: ['on_route'],
};

/**
 * Update a journey's status (US9.9). Going On route with an ETA of 15 minutes or less sends the customer the car's
 * registration, colour and make by text (once) when they chose text updates; email customers get an email (US4.3).
 */
router.post(
  '/bookings/:id/status',
  body(statusSchema),
  wrap(async (req, res) => {
    idCheck(req.params.id);
    const { status, etaMinutes } = req.body;
    const result = await tx(async (db) => {
      const lock = await db.query('SELECT status FROM bookings WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!lock.rowCount) throw notFound('Booking not found');
      const row = await loadBookingRow(db, req.params.id);
      if (!TRANSITIONS[status].includes(row.status)) {
        throw new HttpError(409, `A ${row.status.replace('_', ' ')} booking cannot be set to ${status.replace('_', ' ')}.`, 'bad_status');
      }
      if (!row.driver_id) throw new HttpError(409, 'Assign a driver first.', 'no_driver');
      if (status === 'on_route' && !etaMinutes) throw badRequest('Enter the ETA in minutes', { etaMinutes: 'Enter the ETA in minutes' });

      const sent = [];
      await db.query(
        `UPDATE bookings SET status=$2, eta_minutes=$3, updated_at=now() WHERE id=$1`,
        [row.id, status, status === 'on_route' ? etaMinutes : null],
      );

      if (status === 'on_route') {
        const wantsText = ['text', 'both'].includes(row.notify_pref);
        const wantsEmail = ['email', 'both'].includes(row.notify_pref);
        if (wantsText && etaMinutes <= 15 && !row.arrival_sms_sent_at) {
          const n = await sendSms({ userId: row.customer_id, to: row.notify_phone || row.customer_phone, body: arrivalSmsText(row, etaMinutes), kind: 'driver_near', bookingId: row.id, sentBy: req.user.id }, db);
          await db.query('UPDATE bookings SET arrival_sms_sent_at=now() WHERE id=$1', [row.id]);
          sent.push({ channel: 'sms', id: n.id, body: n.body });
        }
        if (wantsEmail) {
          const prev = await db.query("SELECT 1 FROM notifications WHERE booking_id=$1 AND kind='driver_on_route'", [row.id]);
          if (!prev.rowCount) {
            const n = await sendEmail({
              userId: row.customer_id,
              to: row.customer_email,
              kind: 'driver_on_route',
              bookingId: row.id,
              sentBy: req.user.id,
              subject: `Your driver is on the way - ${row.ref}`,
              body: `Hello ${row.customer_name},\n\nYour driver ${row.driver_name} is on the way (about ${etaMinutes} minutes).\n\nCar: ${row.cab_colour} ${row.cab_make} ${row.cab_model}\nRegistration: ${row.cab_reg}\n\nPlease check the registration matches before you get in.\n\nThe Private Hire Cars team`,
            }, db);
            sent.push({ channel: 'email', id: n.id });
          }
        }
      }

      if (status === 'completed') {
        await sendEmail({
          userId: row.customer_id,
          to: row.customer_email,
          kind: 'journey_completed',
          bookingId: row.id,
          sentBy: req.user.id,
          subject: `How was your journey? - ${row.ref}`,
          body: `Hello ${row.customer_name},\n\nThank you for travelling with Private Hire Cars.\n\nPlease tell us how it went - rate your journey, the car and your driver from My trips.\n\nThe Private Hire Cars team`,
        }, db);
      }
      return { row: await loadBookingRow(db, row.id), sent };
    });
    const settings = await getSettings();
    res.json({ booking: serializeBooking(result.row, { cancelWindowHours: settings.cancelWindowHours, forStaff: true }), sent: result.sent });
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
           count(*) FILTER (WHERE (pickup_at AT TIME ZONE 'Europe/London')::date = (now() AT TIME ZONE 'Europe/London')::date AND status <> 'cancelled')::int AS today,
           count(*) FILTER (WHERE status = 'confirmed' AND end_at >= now())::int AS needs_driver,
           count(*) FILTER (WHERE status = 'on_route')::int AS on_route,
           count(*) FILTER (WHERE priority AND status IN ('confirmed','assigned') AND end_at >= now())::int AS priority_open
         FROM bookings`,
      )
    ).rows[0];
    const enquiries = (await query("SELECT count(*)::int AS n FROM enquiries WHERE status='new'")).rows[0].n;
    const { rows } = await query(
      `SELECT id FROM bookings WHERE status IN ('confirmed','assigned') AND end_at >= now()
        ORDER BY priority DESC, pickup_at ASC LIMIT 6`,
    );
    const next = [];
    for (const r of rows) next.push(serializeBooking(await loadBookingRow(null, r.id), { cancelWindowHours: settings.cancelWindowHours, forStaff: true }));
    res.json({ stats: { today: stats.today, needsDriver: stats.needs_driver, onRoute: stats.on_route, priorityOpen: stats.priority_open, newEnquiries: enquiries }, next });
  }),
);
