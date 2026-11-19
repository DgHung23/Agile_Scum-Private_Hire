import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { staffOnly, serializeUser } from '../middleware/auth.js';
import { body, queryOf, wrap } from '../middleware/validate.js';
import { HttpError, notFound } from '../errors.js';
import { normalisePostcode, profileFields } from '../schemas.js';
import { sendEmail, templates } from '../services/notify.js';
import { createBooking, getSettings, loadBookingRow, serializeBooking } from '../services/booking.js';
import { cancelBooking, amendBooking } from '../services/changes.js';
import { cardInputSchema, recordDeclined, serializePayment } from '../services/payments.js';
import { journeySchema } from './bookings.js';

export const router = Router();
router.use(...staffOnly);

const uuid = z.string().uuid();
const checkId = (id) => {
  if (!uuid.safeParse(id).success) throw notFound();
};

/* ---------------- search (US9.2) ---------------- */

const maskEmail = (e) => {
  const [u, d] = e.split('@');
  const [dn, ...tld] = d.split('.');
  return `${u[0]}${'*'.repeat(Math.max(2, u.length - 1))}@${dn[0]}${'*'.repeat(Math.max(2, dn.length - 1))}.${tld.join('.')}`;
};
const maskPhone = (p) => `•••• ${p.replace(/\D/g, '').slice(-4)}`;

/** Search returns only masked details - the account opens after the caller is verified. */
router.get(
  '/customers/search',
  queryOf(z.object({ q: z.string().trim().min(2, 'Type at least 2 characters').max(80) })),
  wrap(async (req, res) => {
    const q = req.query.q;
    const digits = q.replace(/\D/g, '');
    const { rows } = await query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.postcode, u.city, u.created_at,
              (SELECT count(*)::int FROM bookings b WHERE b.customer_id = u.id) AS bookings
         FROM users u
        WHERE u.role = 'customer' AND u.is_active
          AND (u.full_name ILIKE '%' || $1 || '%' OR u.email::text ILIKE '%' || $1 || '%'
               OR ($2 <> '' AND regexp_replace(u.phone, '\\D', '', 'g') LIKE '%' || $2 || '%')
               OR EXISTS (SELECT 1 FROM bookings b WHERE b.customer_id = u.id AND upper(b.ref) = upper($1)))
        ORDER BY u.full_name LIMIT 20`,
      [q, digits.length >= 3 ? digits : ''],
    );
    res.json({
      customers: rows.map((u) => ({
        id: u.id,
        fullName: u.full_name,
        maskedEmail: maskEmail(u.email),
        maskedPhone: maskPhone(u.phone),
        city: u.city,
        bookings: u.bookings,
        memberSince: u.created_at,
      })),
    });
  }),
);

/* ---------------- verification (US9.2) ---------------- */

const REQUIRED_MATCHES = 2;
const MAX_FAILED = 5;

const answersSchema = z.object({
  answers: z.object({
    postcode: z.string().trim().max(12).optional(),
    phoneLast4: z.string().trim().max(4).optional(),
    email: z.string().trim().max(200).optional(),
    bookingRef: z.string().trim().max(20).optional(),
    houseNumber: z.string().trim().max(60).optional(),
  }),
  confirmed: z.boolean().optional(),
});

async function verifiedBy(staffId, customerId) {
  const { rows } = await query(
    'SELECT id FROM caller_verifications WHERE staff_id=$1 AND customer_id=$2 AND verified AND expires_at > now() LIMIT 1',
    [staffId, customerId],
  );
  return rows[0] || null;
}

async function requireVerified(req, customerId) {
  if (!(await verifiedBy(req.user.id, customerId))) {
    throw new HttpError(403, 'Verify the caller before opening this account.', 'not_verified');
  }
}

router.post(
  '/customers/:id/verify',
  body(answersSchema),
  wrap(async (req, res) => {
    checkId(req.params.id);
    const { rows } = await query("SELECT * FROM users WHERE id=$1 AND role='customer' AND is_active", [req.params.id]);
    const c = rows[0];
    if (!c) throw notFound('Customer not found');

    const failed = await query(
      "SELECT count(*)::int AS n FROM caller_verifications WHERE customer_id=$1 AND NOT verified AND created_at > now() - interval '15 minutes'",
      [c.id],
    );
    if (failed.rows[0].n >= MAX_FAILED) {
      throw new HttpError(429, 'Too many failed checks for this account. Ask the caller to log in online or try again in 15 minutes.', 'locked');
    }

    const a = req.body.answers;
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const results = {};
    if (a.postcode) results.postcode = normalisePostcode(a.postcode) === c.postcode;
    if (a.phoneLast4) results.phone_last4 = a.phoneLast4 === c.phone.replace(/\D/g, '').slice(-4);
    if (a.email) results.email = norm(a.email) === norm(c.email);
    if (a.houseNumber) results.house_number = norm(c.address_line).startsWith(norm(a.houseNumber));
    if (a.bookingRef) {
      const r = await query('SELECT 1 FROM bookings WHERE customer_id=$1 AND upper(ref)=upper($2)', [c.id, a.bookingRef]);
      results.booking_ref = r.rowCount > 0;
    }
    const methods = Object.entries(results).filter(([, ok]) => ok).map(([k]) => k);
    const passed = methods.length >= REQUIRED_MATCHES;
    const confirmed = !!req.body.confirmed;

    // The "Identity verified" box is a second, human decision on top of the data checks.
    const verified = passed && confirmed;
    await query(
      'INSERT INTO caller_verifications (staff_id, customer_id, methods, matched, verified, reason) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.user.id, c.id, methods, methods.length, verified, verified ? 'checks_passed' : 'failed'],
    );
    if (!passed && Object.keys(results).length) {
      // Only say which checks matched, never what the right answer is
      return res.status(200).json({ verified: false, matched: methods.length, needed: REQUIRED_MATCHES, results });
    }
    if (passed && !confirmed) {
      return res.json({ verified: false, matched: methods.length, needed: REQUIRED_MATCHES, results, awaitingConfirmation: true });
    }
    res.json({ verified, matched: methods.length, needed: REQUIRED_MATCHES, results });
  }),
);

/* ---------------- customer record (after verification) ---------------- */

const customerBookings = async (customerId, limit = 20) => {
  const settings = await getSettings();
  const { rows } = await query('SELECT id FROM bookings WHERE customer_id=$1 ORDER BY pickup_at DESC LIMIT $2', [customerId, limit]);
  const out = [];
  for (const r of rows) out.push(serializeBooking(await loadBookingRow(null, r.id), { cancelWindowHours: settings.cancelWindowHours, forStaff: true }));
  return out;
};

router.get(
  '/customers/:id',
  wrap(async (req, res) => {
    checkId(req.params.id);
    const { rows } = await query("SELECT * FROM users WHERE id=$1 AND role='customer'", [req.params.id]);
    if (!rows[0]) throw notFound('Customer not found');
    await requireVerified(req, rows[0].id);
    const stats = await query(
      `SELECT count(*)::int AS trips, COALESCE(sum(total) FILTER (WHERE status <> 'cancelled'), 0) AS spend
         FROM bookings WHERE customer_id=$1`,
      [rows[0].id],
    );
    res.json({ customer: serializeUser(rows[0]), stats: stats.rows[0], bookings: await customerBookings(rows[0].id) });
  }),
);

/* ---------------- new account for a caller (US9.3) ---------------- */

const newCustomerSchema = z.object({
  fullName: profileFields.fullName,
  email: profileFields.email,
  phone: profileFields.phone,
  addressLine: profileFields.addressLine,
  city: profileFields.city,
  postcode: profileFields.postcode,
  notifyPref: z.enum(['email', 'text', 'both']).optional(),
  signupChannel: z.enum(['phone', 'in_person']).default('phone'),
});

router.post(
  '/customers',
  body(newCustomerSchema),
  wrap(async (req, res) => {
    const d = req.body;
    // Random password: the customer chooses their own with "Forgot password" from the email we send
    const hash = await bcrypt.hash(crypto.randomBytes(18).toString('base64url') + 'a1', 10);
    const user = await tx(async (db) => {
      const dup = await db.query("SELECT id, full_name FROM users WHERE email=$1", [d.email]);
      if (dup.rowCount) {
        throw new HttpError(409, 'A customer with that email already exists. Search for them and verify the caller instead.', 'email_taken', {
          email: 'A customer with that email already exists.',
        }).withExtra({ existing: { id: dup.rows[0].id, fullName: dup.rows[0].full_name } });
      }
      const { rows } = await db.query(
        `INSERT INTO users (role,email,password_hash,full_name,phone,address_line,city,postcode,notify_pref,signup_channel,created_by)
         VALUES ('customer',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [d.email, hash, d.fullName, d.phone, d.addressLine, d.city, normalisePostcode(d.postcode), d.notifyPref || 'email', d.signupChannel, req.user.id],
      );
      const u = rows[0];
      await db.query(
        "INSERT INTO caller_verifications (staff_id, customer_id, methods, matched, verified, reason) VALUES ($1,$2,'{new_account}',0,true,'new_account')",
        [req.user.id, u.id],
      );
      const mail = templates.accountCreatedByStaff(u);
      await sendEmail({ userId: u.id, to: u.email, kind: 'welcome', sentBy: req.user.id, ...mail }, db);
      return u;
    });
    res.status(201).json({ customer: serializeUser(user) });
  }),
);

/* ---------------- bookings made by staff (US9.5, R3, R13) ---------------- */

const staffPaymentSchema = z
  .discriminatedUnion('method', [
    z.object({ method: z.literal('card'), card: cardInputSchema }),
    z.object({ method: z.literal('cash') }),
  ])
  .optional();

const staffBookingSchema = journeySchema.extend({
  customerId: z.string({ error: 'Choose a customer' }).uuid('Choose a customer'),
  channel: z.enum(['phone', 'in_person'], { error: 'Choose Phone or In person' }),
  sizeCode: z.string({ error: 'Choose a cab size' }).min(1, 'Choose a cab size'),
  notifyPref: z.enum(['email', 'text', 'both']).default('email'),
  notes: z.string().trim().max(300).optional(),
  offerCode: z.string().trim().max(30).optional(),
  payment: staffPaymentSchema,
});

router.post(
  '/bookings',
  body(staffBookingSchema),
  wrap(async (req, res) => {
    const d = req.body;
    const { rows } = await query("SELECT * FROM users WHERE id=$1 AND role='customer' AND is_active", [d.customerId]);
    const customer = rows[0];
    if (!customer) throw notFound('Customer not found');
    await requireVerified(req, customer.id); // US9.2: no booking on an unverified account

    let out;
    try {
      out = await tx((db) =>
        createBooking(db, {
          customer,
          input: d,
          channel: d.channel, // phone / in_person: NO 15% online discount (R3, US9.5 criterion 2)
          createdBy: req.user.id,
          payment: d.payment || null,
        }),
      );
    } catch (e) {
      if (e.code === 'payment_declined') {
        await recordDeclined({ userId: customer.id, amount: 0, method: d.payment?.method || 'card', card: e.card, reason: e.message }).catch(() => {});
      }
      throw e;
    }
    res.status(201).json({
      booking: serializeBooking(out.row, { cancelWindowHours: out.settings.cancelWindowHours, forStaff: true }),
      payment: out.payment ? serializePayment(out.payment) : null,
    });
  }),
);

const bookingList = z.object({
  when: z.enum(['today', 'upcoming', 'past', 'all']).default('upcoming'),
  status: z.enum(['confirmed', 'assigned', 'on_route', 'completed', 'cancelled']).optional(),
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** Staff bookings list: priority (online) bookings first within the same hour. Used by the dashboard and dispatch. */
router.get(
  '/bookings',
  queryOf(bookingList),
  wrap(async (req, res) => {
    const { when, status, q, limit } = req.query;
    const settings = await getSettings();
    const { rows } = await query(
      `SELECT b.id FROM bookings b JOIN users u ON u.id = b.customer_id
        WHERE ($1 = 'all'
               OR ($1 = 'today' AND (b.pickup_at AT TIME ZONE 'Europe/London')::date = (now() AT TIME ZONE 'Europe/London')::date)
               OR ($1 = 'upcoming' AND b.end_at >= now())
               OR ($1 = 'past' AND b.end_at < now()))
          AND ($2::text IS NULL OR b.status = $2)
          AND ($3::text IS NULL OR upper(b.ref) = upper($3) OR u.full_name ILIKE '%' || $3 || '%' OR b.pickup ILIKE '%' || $3 || '%' OR b.destination ILIKE '%' || $3 || '%')
        ORDER BY (CASE WHEN $1 = 'past' THEN NULL ELSE b.pickup_at END) ASC, b.pickup_at DESC, b.priority DESC
        LIMIT $4`,
      [when, status || null, q || null, limit],
    );
    const bookings = [];
    for (const r of rows) bookings.push(serializeBooking(await loadBookingRow(null, r.id), { cancelWindowHours: settings.cancelWindowHours, forStaff: true }));
    res.json({ bookings });
  }),
);

router.get(
  '/bookings/:id',
  wrap(async (req, res) => {
    checkId(req.params.id);
    const row = await loadBookingRow(null, req.params.id);
    if (!row) throw notFound('Booking not found');
    const settings = await getSettings();
    const pay = await query("SELECT * FROM payments WHERE booking_id=$1 AND status='approved' ORDER BY created_at", [row.id]);
    res.json({ booking: serializeBooking(row, { cancelWindowHours: settings.cancelWindowHours, forStaff: true }), payments: pay.rows.map(serializePayment) });
  }),
);

const reasonSchema = z.object({ reason: z.string().trim().max(300).optional() });

/** Staff may cancel at any time (the 24h rule binds customers only). */
router.post(
  '/bookings/:id/cancel',
  body(reasonSchema),
  wrap(async (req, res) => {
    checkId(req.params.id);
    const out = await tx((db) => cancelBooking(db, { id: req.params.id, actor: req.user, reason: req.body.reason || null, override: true }));
    res.json({
      booking: serializeBooking(out.booking, { cancelWindowHours: out.settings.cancelWindowHours, forStaff: true }),
      refund: out.refund ? serializePayment(out.refund) : null,
    });
  }),
);

const amendSchema = z.object({
  pickup: z.string().trim().min(1, 'Pickup location is required').max(200),
  destination: z.string().trim().max(200).optional().default(''),
  pickupAt: z.string().min(1, 'Choose a date and time'),
  passengers: z.coerce.number().int().min(1).max(16),
  hours: z.coerce.number().int().optional(),
  sizeCode: z.string().min(1, 'Choose a cab size'),
});

router.post(
  '/bookings/:id/amend',
  body(amendSchema),
  wrap(async (req, res) => {
    checkId(req.params.id);
    const out = await tx((db) => amendBooking(db, { id: req.params.id, actor: req.user, input: req.body, override: true }));
    res.json({ booking: serializeBooking(out.booking, { cancelWindowHours: out.settings.cancelWindowHours, forStaff: true }), difference: out.plan.difference });
  }),
);
