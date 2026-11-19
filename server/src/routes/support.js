import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { authenticate, customerOnly, endOtherSessions, managerOnly, optionalAuth, staffOnly } from '../middleware/auth.js';
import { body, queryOf, wrap } from '../middleware/validate.js';
import { HttpError, badRequest, notFound } from '../errors.js';
import { emailSchema } from '../schemas.js';
import { audit } from '../services/audit.js';
import { sendEmail, sendSms } from '../services/notify.js';
import { requireVerified } from './callcentre.js';

/**
 * Support (report Appendix G): lost property (N23, N28), complaints (N24, N33), customer notes (N29),
 * favourite places (ID-22), my personal data (ID-16).
 */
export const router = Router(); // /support
export const staffRouter = Router(); // /staff

const uuid = z.string().uuid();
const checkId = (id, what = 'Not found') => {
  if (!uuid.safeParse(id).success) throw notFound(what);
};

/** Five working days from now (Monday to Friday), for complaint answers. */
export function workingDaysFrom(start, days) {
  const d = new Date(start);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return d;
}

/* ===================== lost property (N23, N28) ===================== */

export const LOST_STATUS = {
  reported: 'Reported',
  searching: 'Searching',
  found: 'Found',
  ready: 'Ready to collect',
  sent: 'Sent by courier',
  returned: 'Returned',
  not_found: 'Not found',
};

const serializeLost = (r) => ({
  id: r.id,
  kind: r.kind,
  description: r.description,
  colour: r.colour,
  contactPref: r.contact_pref,
  status: r.status,
  statusLabel: LOST_STATUS[r.status],
  bookingId: r.booking_id,
  ref: r.ref || null,
  matchedWith: r.matched_with,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.customer_name !== undefined ? { customer: r.customer_name ? { name: r.customer_name, email: r.customer_email } : null } : {}),
});

async function tellLostStatus(db, item) {
  if (!item.customer_id) return;
  const { rows } = await db.query('SELECT full_name, email, phone FROM users WHERE id=$1', [item.customer_id]);
  const u = rows[0];
  if (!u) return;
  const text = `Your lost item "${item.description}" is now: ${LOST_STATUS[item.status]}.${item.status === 'ready' ? ' You can collect it free from our office, or ask us for a courier at your own cost.' : ''}`;
  if (item.contact_pref === 'text') await sendSms({ userId: item.customer_id, to: u.phone, kind: 'lost_item', bookingId: item.booking_id, body: `Private Hire: ${text}` }, db);
  else await sendEmail({ userId: item.customer_id, to: u.email, kind: 'lost_item', bookingId: item.booking_id, subject: `Lost property update - ${LOST_STATUS[item.status]}`, body: `Hello ${u.full_name},\n\n${text}\n\nThe Private Hire Cars team` }, db);
}

/** A report and a found item on the same booking are matched automatically (Appendix G.1). */
async function autoMatch(db, item) {
  if (!item.booking_id || item.matched_with) return item;
  const other = item.kind === 'reported' ? 'found' : 'reported';
  const { rows } = await db.query(
    "SELECT * FROM lost_items WHERE booking_id=$1 AND kind=$2 AND matched_with IS NULL AND status NOT IN ('returned','not_found') ORDER BY created_at LIMIT 1",
    [item.booking_id, other],
  );
  if (!rows[0]) return item;
  await db.query("UPDATE lost_items SET matched_with=$2, status='found', updated_at=now() WHERE id=$1", [rows[0].id, item.id]);
  const { rows: me } = await db.query("UPDATE lost_items SET matched_with=$2, status='found', updated_at=now() WHERE id=$1 RETURNING *", [item.id, rows[0].id]);
  const report = item.kind === 'reported' ? me[0] : { ...rows[0], status: 'found' };
  await tellLostStatus(db, report);
  return me[0];
}

/** N28 / N36: staff or a driver log a found item on a booking. */
export async function logFoundItem(db, { bookingId, description, colour = null, actor }) {
  const { rows } = await db.query(
    "INSERT INTO lost_items (booking_id, kind, description, colour, status, logged_by) VALUES ($1,'found',$2,$3,'found',$4) RETURNING *",
    [bookingId, description, colour, actor?.id || null],
  );
  return autoMatch(db, rows[0]);
}

const reportSchema = z.object({
  bookingId: uuid.optional(),
  bookingRef: z.string().trim().max(20).optional(),
  email: emailSchema.optional(),
  description: z.string({ error: 'Describe the item' }).trim().min(3, 'Describe the item').max(300),
  colour: z.string().trim().max(40).optional(),
  contactPref: z.enum(['email', 'text', 'phone']).default('email'),
});

/**
 * N23: report a lost item. A signed-in customer picks one of their journeys; someone without an account (or a phone
 * customer) gives the booking reference and the email on the booking. Claims must be tied to a real booking.
 */
router.post(
  '/lost-items',
  optionalAuth,
  body(reportSchema),
  wrap(async (req, res) => {
    const d = req.body;
    let booking;
    if (req.user?.role === 'customer' && d.bookingId) {
      booking = (await query('SELECT id, customer_id, ref FROM bookings WHERE id=$1 AND customer_id=$2', [d.bookingId, req.user.id])).rows[0];
    } else if (d.bookingRef && d.email) {
      booking = (
        await query('SELECT b.id, b.customer_id, b.ref FROM bookings b JOIN users u ON u.id=b.customer_id WHERE upper(b.ref)=upper($1) AND u.email=$2', [d.bookingRef.trim(), d.email])
      ).rows[0];
    }
    if (!booking) {
      throw badRequest('We could not find that journey. Check the booking reference and email.', { bookingRef: 'We could not find a journey with that reference and email' });
    }
    const item = await tx(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO lost_items (booking_id, customer_id, kind, description, colour, contact_pref, status)
         VALUES ($1,$2,'reported',$3,$4,$5,'searching') RETURNING *`,
        [booking.id, booking.customer_id, d.description, d.colour || null, d.contactPref],
      );
      const u = (await db.query('SELECT full_name, email FROM users WHERE id=$1', [booking.customer_id])).rows[0];
      await sendEmail({ userId: booking.customer_id, to: u.email, kind: 'lost_item', bookingId: booking.id, subject: `We are looking for your item - ${booking.ref}`, body: `Hello ${u.full_name},\n\nWe have logged your lost item ("${d.description}") from journey ${booking.ref} and asked the driver to check the car. We will tell you at each step.\n\nThe Private Hire Cars team` }, db);
      return autoMatch(db, rows[0]);
    });
    res.status(201).json({ item: serializeLost({ ...item, ref: booking.ref }) });
  }),
);

router.get(
  '/lost-items',
  ...customerOnly,
  wrap(async (req, res) => {
    const { rows } = await query(
      "SELECT l.*, b.ref FROM lost_items l LEFT JOIN bookings b ON b.id=l.booking_id WHERE l.customer_id=$1 AND l.kind='reported' ORDER BY l.created_at DESC",
      [req.user.id],
    );
    res.json({ items: rows.map(serializeLost) });
  }),
);

/* ===================== complaints (N24, N33) ===================== */

const serializeComplaint = (c) => ({
  id: c.id,
  category: c.category,
  text: c.text,
  status: c.status,
  dueBy: c.due_by,
  overdue: c.status === 'open' && new Date(c.due_by) < new Date(),
  answer: c.answer,
  answeredAt: c.answered_at,
  driverAction: c.driver_action,
  bookingId: c.booking_id,
  ref: c.ref || null,
  createdAt: c.created_at,
  ...(c.customer_name !== undefined ? { customer: c.customer_name, driver: c.driver_name || null } : {}),
});

router.post(
  '/complaints',
  ...customerOnly,
  body(z.object({
    bookingId: uuid.optional(),
    category: z.enum(['driver', 'vehicle', 'route', 'price', 'accessibility', 'safety', 'other'], { error: 'Choose what it is about' }),
    text: z.string({ error: 'Tell us what happened' }).trim().min(10, 'Tell us what happened (at least 10 characters)').max(2000),
  })),
  wrap(async (req, res) => {
    let booking = null;
    if (req.body.bookingId) {
      booking = (await query('SELECT id, ref, driver_id FROM bookings WHERE id=$1 AND customer_id=$2', [req.body.bookingId, req.user.id])).rows[0];
      if (!booking) throw badRequest('Choose one of your journeys', { bookingId: 'Choose one of your journeys' });
    }
    const due = workingDaysFrom(new Date(), 5);
    const c = await tx(async (db) => {
      const { rows } = await db.query(
        'INSERT INTO complaints (booking_id, customer_id, driver_id, category, text, due_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [booking?.id || null, req.user.id, booking?.driver_id || null, req.body.category, req.body.text, due],
      );
      await sendEmail({
        userId: req.user.id, to: req.user.email, kind: 'complaint', bookingId: booking?.id || null,
        subject: 'We have received your complaint',
        body: `Hello ${req.user.full_name},\n\nThank you for telling us. We will answer within 5 working days, by ${due.toDateString()}.\n\nThe Private Hire Cars team`,
      }, db);
      return rows[0];
    });
    res.status(201).json({ complaint: serializeComplaint({ ...c, ref: booking?.ref }) });
  }),
);

router.get(
  '/complaints',
  ...customerOnly,
  wrap(async (req, res) => {
    const { rows } = await query('SELECT c.*, b.ref FROM complaints c LEFT JOIN bookings b ON b.id=c.booking_id WHERE c.customer_id=$1 ORDER BY c.created_at DESC', [req.user.id]);
    res.json({ complaints: rows.map(serializeComplaint) });
  }),
);

/* ===================== ID-22 favourite places ===================== */

router.get(
  '/favourites',
  ...customerOnly,
  wrap(async (req, res) => {
    const { rows } = await query('SELECT * FROM favourite_places WHERE user_id=$1 ORDER BY label', [req.user.id]);
    res.json({ favourites: rows.map((f) => ({ id: f.id, label: f.label, address: f.address })) });
  }),
);

router.post(
  '/favourites',
  ...customerOnly,
  body(z.object({
    label: z.string({ error: 'Give it a name' }).trim().min(1, 'Give it a name, like Home').max(30),
    address: z.string({ error: 'Enter the address' }).trim().min(3, 'Enter the address').max(200),
  })),
  wrap(async (req, res) => {
    const n = await query('SELECT count(*)::int AS n FROM favourite_places WHERE user_id=$1', [req.user.id]);
    if (n.rows[0].n >= 10) throw badRequest('You can save up to 10 places', { label: 'You can save up to 10 places' });
    try {
      const { rows } = await query('INSERT INTO favourite_places (user_id, label, address) VALUES ($1,$2,$3) RETURNING *', [req.user.id, req.body.label, req.body.address]);
      res.status(201).json({ favourite: { id: rows[0].id, label: rows[0].label, address: rows[0].address } });
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'You already have a place with that name.', 'duplicate', { label: 'You already have a place with that name' });
      throw e;
    }
  }),
);

router.delete(
  '/favourites/:id',
  ...customerOnly,
  wrap(async (req, res) => {
    checkId(req.params.id);
    const r = await query('DELETE FROM favourite_places WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!r.rowCount) throw notFound('Place not found');
    res.json({ ok: true });
  }),
);

/* ===================== ID-16 see, download and delete my personal data ===================== */

router.get(
  '/my-data',
  authenticate,
  wrap(async (req, res) => {
    if (req.user.role !== 'customer') throw notFound();
    const id = req.user.id;
    const one = async (sql) => (await query(sql, [id])).rows;
    const data = {
      exportedAt: new Date().toISOString(),
      profile: (await one('SELECT full_name, email, phone, address_line, city, postcode, notify_pref, marketing_consent, created_at FROM users WHERE id=$1'))[0],
      bookings: await one('SELECT ref, status, service_code, pickup, destination, pickup_at, passengers, total, payment_status, created_at FROM bookings WHERE customer_id=$1 ORDER BY pickup_at DESC'),
      payments: await one("SELECT kind, method, amount, card_brand, card_last4, created_at FROM payments WHERE user_id=$1 AND status='approved' ORDER BY created_at DESC"),
      savedCards: await one('SELECT brand, last4, exp_month, exp_year FROM saved_cards WHERE user_id=$1'),
      favouritePlaces: await one('SELECT label, address FROM favourite_places WHERE user_id=$1'),
      reviews: await one('SELECT journey_rating, cab_rating, driver_rating, comment, created_at FROM reviews WHERE customer_id=$1'),
      enquiries: await one('SELECT subject, message, created_at FROM enquiries WHERE user_id=$1'),
      complaints: await one('SELECT category, text, status, answer, created_at FROM complaints WHERE customer_id=$1'),
      messages: await one('SELECT channel, subject, body, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500'),
    };
    await query("INSERT INTO data_requests (user_id, kind, status, completed_at) VALUES ($1,'export','done',now())", [id]);
    res.setHeader('Content-Disposition', 'attachment; filename="PrivateHire-my-data.json"');
    res.json(data);
  }),
);

/**
 * ID-16: delete my account. Personal details are removed at once; booking and payment records stay (without the name)
 * for the 12 months that TfL requires, then the retention job deletes them (N05).
 */
router.post(
  '/delete-account',
  ...customerOnly,
  body(z.object({ currentPassword: z.string().min(1, 'Enter your password') })),
  wrap(async (req, res) => {
    if (!(await bcrypt.compare(req.body.currentPassword, req.user.password_hash))) {
      throw new HttpError(400, 'Your password is not correct.', 'bad_credentials', { currentPassword: 'Your password is not correct.' });
    }
    const upcoming = await query(
      "SELECT count(*)::int AS n FROM bookings WHERE customer_id=$1 AND status IN ('pending_payment','confirmed','assigned','on_route','arrived','in_progress') AND end_at > now()",
      [req.user.id],
    );
    if (upcoming.rows[0].n) {
      throw new HttpError(409, `You have ${upcoming.rows[0].n} upcoming booking(s). Cancel them first, or call us.`, 'has_bookings');
    }
    await tx(async (db) => {
      await db.query("INSERT INTO data_requests (user_id, kind, status, completed_at) VALUES ($1,'delete','done',now())", [req.user.id]);
      await sendEmail({ userId: req.user.id, to: req.user.email, kind: 'account_deleted', subject: 'Your Private Hire Cars account has been deleted', body: `Hello ${req.user.full_name},\n\nAs you asked, we have deleted your account and personal details. We keep anonymous booking and payment records for 12 months, as Transport for London requires.\n\nThe Private Hire Cars team` }, db);
      await anonymiseUser(db, req.user.id);
    });
    res.json({ ok: true });
  }),
);

/** Remove a customer's personal data but keep the anonymous records (shared by ID-16 and the retention job, N05). */
export async function anonymiseUser(db, userId) {
  await db.query(
    `UPDATE users SET full_name='Deleted customer', email=$2, phone='0000000', address_line=NULL, city=NULL, postcode=NULL,
            password_hash=$3, secret_word_hash=NULL, marketing_consent=false, is_active=false, deleted_at=now(), updated_at=now()
      WHERE id=$1`,
    [userId, `deleted-${userId}@privatehire.invalid`, await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10)],
  );
  await db.query('UPDATE bookings SET passenger_name=NULL, passenger_phone=NULL, notify_phone=NULL, note_to_driver=NULL WHERE customer_id=$1', [userId]);
  await db.query('DELETE FROM saved_cards WHERE user_id=$1', [userId]);
  await db.query('DELETE FROM favourite_places WHERE user_id=$1', [userId]);
  await db.query('DELETE FROM customer_notes WHERE customer_id=$1', [userId]);
  await db.query('DELETE FROM customer_coupons WHERE user_id=$1', [userId]);
  await db.query('UPDATE notifications SET body=$2, to_addr=$2 WHERE user_id=$1', [userId, '(removed)']);
  await endOtherSessions(userId, null, db);
}

/* ===================== staff: lost property, complaints, customer notes ===================== */

staffRouter.get(
  '/lost-items',
  ...staffOnly,
  queryOf(z.object({ open: z.enum(['true', 'false']).default('true') })),
  wrap(async (req, res) => {
    const { rows } = await query(
      `SELECT l.*, b.ref, u.full_name AS customer_name, u.email AS customer_email
         FROM lost_items l LEFT JOIN bookings b ON b.id=l.booking_id LEFT JOIN users u ON u.id=l.customer_id
        WHERE ($1 = 'false' OR l.status NOT IN ('returned','not_found'))
        ORDER BY l.created_at DESC LIMIT 200`,
      [req.query.open],
    );
    res.json({ items: rows.map(serializeLost) });
  }),
);

staffRouter.post(
  '/lost-items',
  ...staffOnly,
  body(z.object({ bookingRef: z.string().trim().min(4, 'Enter the booking reference').max(20), description: z.string().trim().min(3, 'Describe the item').max(300), colour: z.string().trim().max(40).optional() })),
  wrap(async (req, res) => {
    const b = (await query('SELECT id FROM bookings WHERE upper(ref)=upper($1)', [req.body.bookingRef])).rows[0];
    if (!b) throw badRequest('No booking with that reference', { bookingRef: 'No booking with that reference' });
    const item = await tx(async (db) => {
      const i = await logFoundItem(db, { bookingId: b.id, description: req.body.description, colour: req.body.colour, actor: req.user });
      await audit(db, req, 'lost.found', 'lost_item', i.id, { bookingRef: req.body.bookingRef });
      return i;
    });
    res.status(201).json({ item: serializeLost(item) });
  }),
);

staffRouter.patch(
  '/lost-items/:id',
  ...staffOnly,
  body(z.object({ status: z.enum(Object.keys(LOST_STATUS)).optional(), matchedWith: uuid.nullable().optional() })),
  wrap(async (req, res) => {
    checkId(req.params.id);
    const item = await tx(async (db) => {
      const { rows } = await db.query('SELECT * FROM lost_items WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!rows[0]) throw notFound('Item not found');
      if (req.body.matchedWith) {
        // staff match a report and a found item by hand (different bookings: same date, car and description)
        await db.query("UPDATE lost_items SET matched_with=$2, status='found', updated_at=now() WHERE id=$1", [req.params.id, req.body.matchedWith]);
        await db.query("UPDATE lost_items SET matched_with=$2, status='found', updated_at=now() WHERE id=$1", [req.body.matchedWith, req.params.id]);
      }
      const { rows: up } = await db.query(
        'UPDATE lost_items SET status=COALESCE($2, status), updated_at=now() WHERE id=$1 RETURNING *',
        [req.params.id, req.body.status || (req.body.matchedWith ? 'found' : null)],
      );
      // a status change on a found item is told to the matching report's owner
      const target = up[0].kind === 'reported' ? up[0] : up[0].matched_with ? (await db.query('SELECT * FROM lost_items WHERE id=$1', [up[0].matched_with])).rows[0] : null;
      if (target && req.body.status && target.id !== up[0].id) await db.query('UPDATE lost_items SET status=$2, updated_at=now() WHERE id=$1', [target.id, req.body.status]);
      if (target) await tellLostStatus(db, { ...target, status: req.body.status || 'found' });
      await audit(db, req, 'lost.update', 'lost_item', req.params.id, req.body);
      return up[0];
    });
    res.json({ item: serializeLost(item) });
  }),
);

staffRouter.get(
  '/complaints',
  ...staffOnly,
  wrap(async (_req, res) => {
    const { rows } = await query(
      `SELECT c.*, b.ref, u.full_name AS customer_name, d.full_name AS driver_name
         FROM complaints c LEFT JOIN bookings b ON b.id=c.booking_id LEFT JOIN users u ON u.id=c.customer_id LEFT JOIN drivers d ON d.id=c.driver_id
        ORDER BY (c.status='open') DESC, c.due_by ASC LIMIT 200`,
    );
    res.json({ complaints: rows.map(serializeComplaint) });
  }),
);

staffRouter.post(
  '/complaints/:id/answer',
  ...staffOnly,
  body(z.object({ answer: z.string({ error: 'Write the answer' }).trim().min(10, 'Write the answer').max(3000) })),
  wrap(async (req, res) => {
    checkId(req.params.id);
    const c = await tx(async (db) => {
      const { rows } = await db.query(
        "UPDATE complaints SET status='answered', answer=$2, answered_by=$3, answered_at=now() WHERE id=$1 RETURNING *",
        [req.params.id, req.body.answer, req.user.id],
      );
      if (!rows[0]) throw notFound('Complaint not found');
      const u = (await db.query('SELECT full_name, email FROM users WHERE id=$1', [rows[0].customer_id])).rows[0];
      if (u) await sendEmail({ userId: rows[0].customer_id, to: u.email, kind: 'complaint_answer', bookingId: rows[0].booking_id, sentBy: req.user.id, subject: 'Our answer to your complaint', body: `Hello ${u.full_name},\n\n${req.body.answer}\n\nThe Private Hire Cars team` }, db);
      await audit(db, req, 'complaint.answer', 'complaint', req.params.id);
      return rows[0];
    });
    res.json({ complaint: serializeComplaint(c) });
  }),
);

/** N33: the Manager reviews a complaint about a driver and acts (warning, retraining, suspension). */
staffRouter.post(
  '/complaints/:id/driver-action',
  ...managerOnly,
  body(z.object({ action: z.string({ error: 'Describe the action' }).trim().min(3, 'Describe the action').max(500), suspendDriver: z.boolean().optional() })),
  wrap(async (req, res) => {
    checkId(req.params.id);
    const c = await tx(async (db) => {
      const { rows } = await db.query("UPDATE complaints SET driver_action=$2, status=CASE WHEN status='open' THEN status ELSE 'closed' END WHERE id=$1 RETURNING *", [req.params.id, req.body.action]);
      if (!rows[0]) throw notFound('Complaint not found');
      if (req.body.suspendDriver && rows[0].driver_id) {
        await db.query('UPDATE drivers SET active=false, updated_at=now() WHERE id=$1', [rows[0].driver_id]);
      }
      await audit(db, req, 'complaint.driver_action', 'complaint', req.params.id, req.body);
      return rows[0];
    });
    res.json({ complaint: serializeComplaint(c) });
  }),
);

/** N29: notes on a customer account (after caller verification). */
staffRouter.get(
  '/customers/:id/notes',
  ...staffOnly,
  wrap(async (req, res) => {
    checkId(req.params.id);
    await requireVerified(req, req.params.id);
    const { rows } = await query(
      'SELECT n.*, u.full_name AS staff_name FROM customer_notes n LEFT JOIN users u ON u.id=n.staff_id WHERE n.customer_id=$1 ORDER BY n.created_at DESC',
      [req.params.id],
    );
    res.json({ notes: rows.map((n) => ({ id: n.id, body: n.body, by: n.staff_name, at: n.created_at })) });
  }),
);

staffRouter.post(
  '/customers/:id/notes',
  ...staffOnly,
  body(z.object({ body: z.string({ error: 'Write a note' }).trim().min(2, 'Write a note').max(1000) })),
  wrap(async (req, res) => {
    checkId(req.params.id);
    await requireVerified(req, req.params.id);
    const { rows } = await query('INSERT INTO customer_notes (customer_id, staff_id, body) VALUES ($1,$2,$3) RETURNING *', [req.params.id, req.user.id, req.body.body]);
    await audit(null, req, 'customer.note', 'user', req.params.id);
    res.status(201).json({ note: { id: rows[0].id, body: rows[0].body, by: req.user.full_name, at: rows[0].created_at } });
  }),
);
