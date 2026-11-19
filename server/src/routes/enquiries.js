import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { authenticate, optionalAuth, staffOnly } from '../middleware/auth.js';
import { body, queryOf, wrap } from '../middleware/validate.js';
import { badRequest, HttpError, notFound } from '../errors.js';
import { emailSchema } from '../schemas.js';
import { sendEmail } from '../services/notify.js';

export const router = Router();
export const staffRouter = Router();
staffRouter.use(...staffOnly);

const serialize = (e, replies = []) => ({
  id: e.id,
  ref: 'EN-' + e.id.slice(0, 6).toUpperCase(),
  name: e.name,
  email: e.email,
  subject: e.subject,
  message: e.message,
  status: e.status,
  bookingId: e.booking_id,
  bookingRef: e.booking_ref || null,
  createdAt: e.created_at,
  repliedAt: e.replied_at,
  replies: replies.map((r) => ({ id: r.id, body: r.body, staffName: r.staff_name, createdAt: r.created_at })),
});

const SELECT = `SELECT e.*, b.ref AS booking_ref FROM enquiries e LEFT JOIN bookings b ON b.id = e.booking_id`;

async function withReplies(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const { rows: reps } = await query(
    `SELECT r.*, u.full_name AS staff_name FROM enquiry_replies r JOIN users u ON u.id = r.staff_id WHERE r.enquiry_id = ANY($1) ORDER BY r.created_at`,
    [ids],
  );
  return rows.map((e) => serialize(e, reps.filter((r) => r.enquiry_id === e.id)));
}

const enquirySchema = z.object({
  name: z.string({ error: 'Name is required' }).trim().min(1, 'Name is required').max(100),
  email: emailSchema,
  subject: z.string({ error: 'Subject is required' }).trim().min(1, 'Subject is required').max(150),
  message: z.string({ error: 'Message is required' }).trim().min(1, 'Message is required').max(2000, 'Please keep your message under 2000 characters'),
  bookingId: z.string().uuid().optional().nullable(),
});

/**
 * US2.1 general enquiry (anyone) and US2.2 enquiry about a specific trip (logged-in customer, own bookings only).
 */
router.post(
  '/',
  optionalAuth,
  body(enquirySchema),
  wrap(async (req, res) => {
    const d = req.body;
    let bookingId = null;
    if (d.bookingId) {
      if (!req.user) throw new HttpError(401, 'Log in to ask about one of your trips.', 'unauthorized');
      const b = await query('SELECT id FROM bookings WHERE id=$1 AND customer_id=$2', [d.bookingId, req.user.id]);
      if (!b.rowCount) throw badRequest('Choose one of your own bookings', { bookingId: 'Choose one of your own bookings' });
      bookingId = b.rows[0].id;
    }
    const e = await tx(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO enquiries (user_id, name, email, subject, message, booking_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.user?.id ?? null, d.name, d.email, d.subject, d.message, bookingId],
      );
      const ref = 'EN-' + rows[0].id.slice(0, 6).toUpperCase();
      await sendEmail(
        {
          userId: req.user?.id ?? null,
          to: d.email,
          kind: 'enquiry_received',
          bookingId,
          subject: `We have your enquiry - ${ref}`,
          body: `Hello ${d.name},\n\nThank you for contacting Private Hire Cars. We have received your enquiry "${d.subject}" and a member of the team will reply by email as soon as possible.\n\nReference: ${ref}\n\nThe Private Hire Cars team`,
        },
        db,
      );
      return rows[0];
    });
    const [out] = await withReplies((await query(`${SELECT} WHERE e.id=$1`, [e.id])).rows);
    res.status(201).json({ enquiry: out });
  }),
);

router.get(
  '/mine',
  authenticate,
  wrap(async (req, res) => {
    const { rows } = await query(`${SELECT} WHERE e.user_id=$1 OR e.email = $2 ORDER BY e.created_at DESC LIMIT 50`, [req.user.id, req.user.email]);
    res.json({ enquiries: await withReplies(rows) });
  }),
);

/* ---------------- staff inbox (US2.3) ---------------- */

staffRouter.get(
  '/enquiries',
  queryOf(z.object({ status: z.enum(['new', 'replied']).optional(), q: z.string().trim().max(60).optional() })),
  wrap(async (req, res) => {
    const { status, q } = req.query;
    const { rows } = await query(
      `${SELECT}
        WHERE ($1::text IS NULL OR e.status = $1)
          AND ($2::text IS NULL OR e.subject ILIKE '%' || $2 || '%' OR e.name ILIKE '%' || $2 || '%' OR e.email::text ILIKE '%' || $2 || '%')
        ORDER BY e.created_at DESC LIMIT 200`,
      [status || null, q || null],
    );
    const counts = (await query("SELECT status, count(*)::int AS n FROM enquiries GROUP BY status")).rows;
    res.json({
      enquiries: await withReplies(rows),
      counts: { new: counts.find((c) => c.status === 'new')?.n || 0, replied: counts.find((c) => c.status === 'replied')?.n || 0 },
    });
  }),
);

staffRouter.post(
  '/enquiries/:id/reply',
  body(z.object({ message: z.string({ error: 'Write a reply' }).trim().min(1, 'Write a reply').max(3000) })),
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Enquiry not found');
    const out = await tx(async (db) => {
      const { rows } = await db.query('SELECT * FROM enquiries WHERE id=$1 FOR UPDATE', [req.params.id]);
      const e = rows[0];
      if (!e) throw notFound('Enquiry not found');
      await db.query('INSERT INTO enquiry_replies (enquiry_id, staff_id, body) VALUES ($1,$2,$3)', [e.id, req.user.id, req.body.message]);
      await db.query("UPDATE enquiries SET status='replied', replied_at=now() WHERE id=$1", [e.id]);
      const ref = 'EN-' + e.id.slice(0, 6).toUpperCase();
      await sendEmail(
        {
          userId: e.user_id,
          to: e.email,
          kind: 'enquiry_reply',
          bookingId: e.booking_id,
          sentBy: req.user.id,
          subject: `Re: ${e.subject} (${ref})`,
          body: `Hello ${e.name},\n\n${req.body.message}\n\nKind regards,\n${req.user.full_name}\nPrivate Hire Cars\n\n--- Your enquiry ---\n${e.message}`,
        },
        db,
      );
      return e.id;
    });
    const [enq] = await withReplies((await query(`${SELECT} WHERE e.id=$1`, [out])).rows);
    res.json({ enquiry: enq });
  }),
);

/** US9.8: email a customer from the system so all contact is recorded in one place. */
staffRouter.post(
  '/customers/:id/email',
  body(z.object({
    subject: z.string({ error: 'Subject is required' }).trim().min(1, 'Subject is required').max(150),
    message: z.string({ error: 'Message is required' }).trim().min(1, 'Message is required').max(3000),
  })),
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Customer not found');
    const { rows } = await query("SELECT * FROM users WHERE id=$1 AND role='customer'", [req.params.id]);
    const c = rows[0];
    if (!c) throw notFound('Customer not found');
    const ok = await query('SELECT 1 FROM caller_verifications WHERE staff_id=$1 AND customer_id=$2 AND verified AND expires_at > now() LIMIT 1', [req.user.id, c.id]);
    if (!ok.rowCount) throw new HttpError(403, 'Open the customer record (verify the caller) before emailing.', 'not_verified');
    const n = await sendEmail({
      userId: c.id,
      to: c.email,
      kind: 'staff_email',
      sentBy: req.user.id,
      subject: req.body.subject,
      body: `Hello ${c.full_name},\n\n${req.body.message}\n\nKind regards,\n${req.user.full_name}\nPrivate Hire Cars`,
    });
    res.status(201).json({ id: n.id });
  }),
);
