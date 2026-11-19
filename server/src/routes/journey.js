import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { customerOnly, staffOnly } from '../middleware/auth.js';
import { body, wrap } from '../middleware/validate.js';
import { HttpError, notFound } from '../errors.js';
import { config } from '../config.js';
import { audit } from '../services/audit.js';
import { loadBookingRow } from '../services/booking.js';
import { sendEmail, sendSms } from '../services/notify.js';

/** During a journey: share my trip (N21), problem with my journey (N20), emergency button (N22). */
export const router = Router(); // /bookings
export const publicRouter = Router(); // /track
export const staffRouter = Router(); // /staff

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const ACTIVE = ['confirmed', 'assigned', 'on_route', 'arrived', 'in_progress', 'interrupted'];

async function ownBooking(req) {
  if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Booking not found');
  const row = await loadBookingRow(null, req.params.id);
  if (!row || row.customer_id !== req.user.id) throw notFound('Booking not found');
  return row;
}

/** N21: a private link that shows the car, driver first name and status - no personal data. */
router.post(
  '/:id/share',
  ...customerOnly,
  body(z.object({ contact: z.string().trim().max(120).optional() })),
  wrap(async (req, res) => {
    const row = await ownBooking(req);
    if (!ACTIVE.includes(row.status)) throw new HttpError(409, 'Only upcoming or current journeys can be shared.', 'not_shareable');
    const token = crypto.randomBytes(18).toString('base64url');
    const expires = new Date(new Date(row.end_at).getTime() + 2 * 3600_000);
    await query('INSERT INTO trip_shares (token_hash, booking_id, created_by, contact, expires_at) VALUES ($1,$2,$3,$4,$5)', [
      sha(token), row.id, req.user.id, req.body.contact || null, expires,
    ]);
    const url = `${config.publicUrl}/track/${token}`;
    const c = req.body.contact || '';
    if (/@/.test(c)) {
      await sendEmail({ userId: req.user.id, to: c, kind: 'trip_share', bookingId: row.id, subject: `${req.user.full_name} shared a journey with you`, body: `${req.user.full_name} shared their Private Hire Cars journey with you.\n\nFollow it here: ${url}\n\nThe link stops working 2 hours after the journey.` });
    } else if (/\d{7,}/.test(c.replace(/\D/g, ''))) {
      await sendSms({ userId: req.user.id, to: c, kind: 'trip_share', bookingId: row.id, body: `${req.user.full_name} shared a Private Hire journey with you: ${url}` });
    }
    res.status(201).json({ url, expiresAt: expires });
  }),
);

router.delete(
  '/:id/share',
  ...customerOnly,
  wrap(async (req, res) => {
    const row = await ownBooking(req);
    await query('UPDATE trip_shares SET revoked_at=now() WHERE booking_id=$1 AND revoked_at IS NULL', [row.id]);
    res.json({ ok: true });
  }),
);

publicRouter.get(
  '/:token',
  wrap(async (req, res) => {
    const { rows } = await query('SELECT * FROM trip_shares WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()', [sha(req.params.token)]);
    if (!rows[0]) throw notFound('This link has expired or was turned off.');
    const b = await loadBookingRow(null, rows[0].booking_id);
    const withCar = ['assigned', 'on_route', 'arrived', 'in_progress', 'completed'].includes(b.status);
    res.json({
      trip: {
        status: b.status,
        pickupAt: b.pickup_at,
        pickupArea: b.pickup,
        destination: b.destination,
        etaMinutes: b.status === 'on_route' ? b.eta_minutes : null,
        vehicle: withCar ? { reg: b.cab_reg, colour: b.cab_colour, make: b.cab_make, model: b.cab_model } : null,
        driverFirstName: withCar && b.driver_name ? b.driver_name.split(' ')[0] : null,
        sharedBy: (await query('SELECT full_name FROM users WHERE id=$1', [rows[0].created_by])).rows[0].full_name.split(' ')[0],
      },
    });
  }),
);

/**
 * N20 "Problem with my journey" and N22 emergency button. Staff are alerted at once (dashboard and email to the
 * control room). For an emergency the screen also tells the customer to call 999.
 */
router.post(
  '/:id/incident',
  ...customerOnly,
  body(z.object({ kind: z.enum(['emergency', 'problem']), message: z.string().trim().max(500).optional() })),
  wrap(async (req, res) => {
    const row = await ownBooking(req);
    if (!ACTIVE.includes(row.status)) throw new HttpError(409, 'This journey is not active. Please send us an enquiry instead.', 'not_active');
    const out = await tx(async (db) => {
      const { rows } = await db.query(
        'INSERT INTO incidents (booking_id, reported_by, kind, message) VALUES ($1,$2,$3,$4) RETURNING *',
        [row.id, req.user.id, req.body.kind, req.body.message || null],
      );
      await sendEmail(
        {
          to: 'control@privatehire.example',
          kind: req.body.kind === 'emergency' ? 'incident_emergency' : 'incident_problem',
          bookingId: row.id,
          subject: `${req.body.kind === 'emergency' ? 'EMERGENCY' : 'Problem'} on ${row.ref}`,
          body: `${req.user.full_name} (${req.user.phone}) reported ${req.body.kind === 'emergency' ? 'an EMERGENCY' : 'a problem'} on booking ${row.ref}.\n\n${req.body.message || '(no message)'}\n\nCar: ${row.cab_reg}. Driver: ${row.driver_name || 'not assigned'}.`,
        },
        db,
      );
      return rows[0];
    });
    res.status(201).json({
      incident: { id: out.id, kind: out.kind, createdAt: out.created_at },
      message:
        out.kind === 'emergency'
          ? 'If anyone is in danger, call 999 now. Our control room has been alerted and will call you.'
          : 'Thank you. Our control room has been told and will call you shortly.',
    });
  }),
);

/* ---------- staff: open incidents ---------- */

staffRouter.get(
  '/incidents',
  ...staffOnly,
  wrap(async (_req, res) => {
    const { rows } = await query(
      `SELECT i.*, b.ref, b.pickup, b.destination, u.full_name AS reporter, u.phone AS reporter_phone
         FROM incidents i JOIN bookings b ON b.id = i.booking_id LEFT JOIN users u ON u.id = i.reported_by
        ORDER BY (i.status = 'open') DESC, i.created_at DESC LIMIT 100`,
    );
    res.json({
      incidents: rows.map((r) => ({
        id: r.id, kind: r.kind, status: r.status, message: r.message, createdAt: r.created_at, handledAt: r.handled_at,
        booking: { id: r.booking_id, ref: r.ref, pickup: r.pickup, destination: r.destination },
        reporter: r.reporter ? { name: r.reporter, phone: r.reporter_phone } : null,
      })),
    });
  }),
);

staffRouter.post(
  '/incidents/:id/handle',
  ...staffOnly,
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Incident not found');
    const r = await tx(async (db) => {
      const { rows } = await db.query(
        "UPDATE incidents SET status='handled', handled_by=$2, handled_at=now() WHERE id=$1 AND status='open' RETURNING *",
        [req.params.id, req.user.id],
      );
      if (rows[0]) await audit(db, req, 'incident.handle', 'incident', rows[0].id, { kind: rows[0].kind });
      return rows[0];
    });
    if (!r) throw notFound('Incident not found or already handled');
    res.json({ ok: true });
  }),
);
