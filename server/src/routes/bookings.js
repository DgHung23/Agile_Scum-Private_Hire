import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { customerOnly, optionalAuth } from '../middleware/auth.js';
import { body, queryOf, wrap } from '../middleware/validate.js';
import { HttpError, notFound } from '../errors.js';
import { resolveCoupon } from '../services/offers.js';
import { availabilityBySize, expireHolds } from '../services/availability.js';
import { cancelBooking, amendBooking, planAmendment } from '../services/changes.js';
import { serializePayment, describeMethod } from '../services/payments.js';
import { abandonGroup, beginPayment, complete3ds, completeRedirect, paymentSchema } from '../services/checkout.js';
import {
  createBooking,
  getSettings,
  loadBookingRow,
  loadGroup,
  prepareJourney,
  priceFor,
  serializeBooking,
  sizeProblems,
} from '../services/booking.js';

export const router = Router();

export async function buildReceipt(row, customer) {
  const pay = await query("SELECT * FROM payments WHERE booking_id=$1 AND status='approved' ORDER BY created_at", [row.id]);
  const payments = pay.rows.map((p) => ({ ...serializePayment(p), description: describeMethod(p) }));
  const paid = payments.filter((p) => p.kind === 'charge').reduce((a, p) => a + p.amount, 0);
  const refunded = payments.filter((p) => p.kind === 'refund').reduce((a, p) => a + p.amount, 0);
  const first = payments.find((p) => p.kind === 'charge');
  const b = serializeBooking(row);
  return {
    receiptNo: 'RC-' + row.ref.slice(3),
    issuedAt: first?.createdAt || row.created_at,
    company: { name: 'Private Hire Cars', address: 'London, United Kingdom', phone: '020 7000 0000', email: 'bookings@privatehire.example' },
    customer: { name: customer.full_name, email: customer.email, address: [customer.address_line, customer.city, customer.postcode].filter(Boolean).join(', ') },
    booking: { ref: b.ref, status: b.status, service: b.service.label, pickup: b.pickup, destination: b.destination, pickupAt: b.pickupAt, passengers: b.passengers, size: b.size.label, hours: b.hours, channel: b.channel },
    price: b.price,
    payments,
    totalPaid: Math.round(paid * 100) / 100,
    totalRefunded: Math.round(refunded * 100) / 100,
    netPaid: Math.round((paid - refunded) * 100) / 100,
  };
}

const optionalText = (max) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));

/** One journey request (ID-28, ID-29, ID-30, ID-38, ID-39, ID-40, ID-41, ID-75, N15, N16). */
export const journeySchema = z.object({
  serviceCode: z.string({ error: 'Choose a service to continue' }).min(1, 'Choose a service to continue'),
  pickup: z.string({ error: 'Pickup location is required' }).trim().max(200).default(''),
  destination: z.string().trim().max(200).optional().default(''),
  pickupAt: z.string().optional().default(''),
  asap: z.boolean().optional(),
  passengers: z.coerce.number({ error: 'Enter the number of passengers' }).int('Enter a whole number').min(1, 'Enter at least 1 passenger').max(8, 'We carry up to 8 passengers in one cab'),
  luggage: z.coerce.number().int().min(0).max(12, 'Enter 0 to 12 bags').optional(),
  childSeatAges: z.array(z.coerce.number().int().min(0).max(11)).max(3, 'We can fit up to 3 child seats').optional(),
  pet: z.boolean().optional(),
  accessibility: z.array(z.enum(['wheelchair', 'assistance_dog', 'help_find_car'])).max(3).optional(),
  passengerName: optionalText(100),
  passengerPhone: optionalText(20),
  flightNo: optionalText(10),
  noteToDriver: optionalText(300),
  packageCode: optionalText(30),
  hours: z.coerce.number().int().optional(),
  returnAt: optionalText(40),
});

const quoteSchema = journeySchema.extend({
  channel: z.enum(['online', 'phone', 'in_person']).optional(),
  offerCode: optionalText(30),
});

const createSchema = journeySchema.extend({
  sizeCode: z.string({ error: 'Choose a cab size' }).min(1, 'Choose a cab size'),
  notifyPref: z.enum(['email', 'text', 'both']).default('email'),
  offerCode: optionalText(30),
  // ID-32: the customer accepts the terms and the cancellation policy before paying.
  acceptTerms: z.literal(true, { error: 'Please accept the terms and cancellation policy to continue' }),
  payment: paymentSchema,
});

/**
 * ID-48, ID-51, ID-52, N13: price every cab size for a journey and report how many cabs are free.
 * Public, so a Visitor can get a fare estimate before signing in; staff may quote for the phone / in-person channel.
 */
router.post(
  '/quote',
  optionalAuth,
  body(quoteSchema),
  wrap(async (req, res) => {
    const isStaff = req.user && ['staff', 'manager'].includes(req.user.role);
    const channel = isStaff && req.body.channel ? req.body.channel : 'online';
    const settings = await getSettings();
    await expireHolds();
    const j = await prepareJourney(null, req.body, { settings });
    const sizes = (await query('SELECT * FROM cab_sizes ORDER BY sort')).rows;
    const counts = await availabilityBySize(null, { ...j.window, wheelchair: j.accessibility.includes('wheelchair') });
    // N16: the return leg reverses the addresses and is priced for its own time (night / zone rules).
    const rj = j.returnAt
      ? await prepareJourney(
          null,
          { ...req.body, pickup: j.destination, destination: j.pickup, pickupAt: j.returnAt.toISOString(), returnAt: null, asap: false, flightNo: null },
          { settings },
        )
      : null;
    let coupon = null;
    if (req.body.offerCode) {
      if (!req.user || req.user.role !== 'customer') throw new HttpError(400, 'Log in to use a coupon.', 'invalid_offer', { offerCode: 'Log in to use a coupon.' });
      coupon = await resolveCoupon(null, req.body.offerCode, req.user.id);
    }

    res.json({
      channel,
      onlineDiscountPct: settings.onlineDiscountPct,
      offer: coupon ? { code: coupon.code, amount: Number(coupon.amount), title: coupon.title } : null,
      distanceMiles: j.distance.miles,
      distanceSource: j.distance.source,
      durationMinutes: j.durationMinutes,
      pickupAt: j.pickupAt,
      night: j.night,
      inZone: j.inZone,
      package: j.pkg,
      returnAt: j.returnAt,
      sizes: sizes.map((s) => {
        const misfit = sizeProblems(s, j);
        const price = priceFor(settings, j, s, {
          channel,
          couponAmount: coupon ? Number(coupon.amount) : 0,
          couponLabel: coupon ? `Coupon ${coupon.code}` : undefined,
        });
        const returnPrice = rj ? priceFor(settings, rj, s, { channel }) : null;
        return {
          code: s.code,
          label: s.label,
          seats: s.seats,
          luggage: s.luggage,
          fitsPassengers: s.seats >= j.passengers,
          fits: !Object.keys(misfit).length,
          misfit: Object.values(misfit)[0] || null,
          available: counts[s.code] || 0,
          price,
          returnPrice,
        };
      }),
    });
  }),
);

/** ID-11 criterion 5: the email address must be verified before the first online booking. */
function requireVerified(req, _res, next) {
  if (!req.user.email_verified) {
    return next(new HttpError(403, 'Please verify your email address before you book. We can send you a new link.', 'email_not_verified'));
  }
  next();
}

function paymentResponse(res, rows, settings, result) {
  const opts = { cancelWindowHours: settings.cancelWindowHours };
  const body = {
    booking: serializeBooking(rows[0], opts),
    bookings: rows.map((r) => serializeBooking(r, opts)),
  };
  if (result.done || result.ok) {
    return res.status(201).json({ ...body, payment: result.payments?.[0] ? serializePayment(result.payments[0]) : null });
  }
  return res.status(202).json({ ...body, nextAction: result.nextAction });
}

/**
 * ID-32, ID-53: confirm an online booking. It is priced and checked again on the server, saved as Pending payment
 * (the cab is held), then payment starts. Card payments continue with a 3D Secure check (202 + nextAction).
 */
router.post(
  '/',
  ...customerOnly,
  requireVerified,
  body(createSchema),
  wrap(async (req, res) => {
    const out = await tx(async (db) => {
      const created = await createBooking(db, { customer: req.user, input: req.body, channel: 'online', createdBy: req.user.id });
      const result = await beginPayment(db, { rows: created.rows, customer: req.user, payment: req.body.payment });
      const rows = await loadGroup(db, created.groupId);
      return { rows, result, settings: created.settings };
    });
    paymentResponse(res, out.rows, out.settings, out.result);
  }),
);

async function ownedGroup(db, req) {
  if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Booking not found');
  const row = await loadBookingRow(db, req.params.id);
  if (!row || row.customer_id !== req.user.id) throw notFound('Booking not found');
  return loadGroup(db, row.group_id);
}

/** ID-54: try paying again (another card, PayPal, bank or cash) with the journey details kept. */
router.post(
  '/:id/pay',
  ...customerOnly,
  body(z.object({ payment: paymentSchema })),
  wrap(async (req, res) => {
    await expireHolds();
    const out = await tx(async (db) => {
      const rows = await ownedGroup(db, req);
      const result = await beginPayment(db, { rows, customer: req.user, payment: req.body.payment });
      return { rows: await loadGroup(db, rows[0].group_id), result, settings: await getSettings(db) };
    });
    paymentResponse(res, out.rows, out.settings, out.result);
  }),
);

/** ID-53: answer the 3D Secure check. A failed check or a declined card keeps the booking Pending payment. */
router.post(
  '/:id/3ds',
  ...customerOnly,
  body(z.object({ challengeId: z.string().uuid('Payment check not found'), code: z.string().trim().max(12) })),
  wrap(async (req, res) => {
    await expireHolds();
    const out = await tx(async (db) => {
      const rows = await ownedGroup(db, req);
      const result = await complete3ds(db, { rows, customer: req.user, challengeId: req.body.challengeId, code: req.body.code });
      return { rows: await loadGroup(db, rows[0].group_id), result, settings: await getSettings(db) };
    });
    if (!out.result.ok) throw out.result.error; // the failed attempt is already committed
    paymentResponse(res, out.rows, out.settings, out.result);
  }),
);

/** ID-55, ID-57: back from PayPal or the bank (simulated). */
router.post(
  '/:id/redirect-complete',
  ...customerOnly,
  body(z.object({ token: z.string().min(8).max(60) })),
  wrap(async (req, res) => {
    await expireHolds();
    const out = await tx(async (db) => {
      const rows = await ownedGroup(db, req);
      const result = await completeRedirect(db, { rows, customer: req.user, token: req.body.token });
      return { rows: await loadGroup(db, rows[0].group_id), result: { ...result, ok: true }, settings: await getSettings(db) };
    });
    paymentResponse(res, out.rows, out.settings, out.result);
  }),
);

/** The customer stops before paying: the held cab and any coupon are released at once. */
router.post(
  '/:id/abandon',
  ...customerOnly,
  wrap(async (req, res) => {
    await tx(async (db) => abandonGroup(db, await ownedGroup(db, req)));
    res.json({ ok: true });
  }),
);

const listQuery = z.object({ when: z.enum(['upcoming', 'past', 'all']).default('all') });

/** ID-33: my upcoming and past bookings (abandoned checkouts are not listed). */
router.get(
  '/',
  ...customerOnly,
  queryOf(listQuery),
  wrap(async (req, res) => {
    await expireHolds();
    const settings = await getSettings();
    const { when } = req.query;
    const done = "('cancelled','company_cancelled','completed','no_show')";
    const { rows } = await query(
      `SELECT b.id FROM bookings b
        WHERE b.customer_id = $1 AND b.status <> 'abandoned'
          AND ($2 = 'all'
               OR ($2 = 'upcoming' AND b.end_at >= now() AND b.status NOT IN ${done})
               OR ($2 = 'past' AND (b.end_at < now() OR b.status IN ${done})))
        ORDER BY (CASE WHEN $2 = 'upcoming' THEN b.pickup_at END) ASC, b.pickup_at DESC
        LIMIT 200`,
      [req.user.id, when],
    );
    const bookings = [];
    for (const r of rows) {
      bookings.push(serializeBooking(await loadBookingRow(null, r.id), { cancelWindowHours: settings.cancelWindowHours }));
    }
    res.json({ bookings });
  }),
);

router.get(
  '/:id',
  ...customerOnly,
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Booking not found');
    await expireHolds();
    const row = await loadBookingRow(null, req.params.id);
    // ID-33: other customers' bookings look exactly like missing ones
    if (!row || row.customer_id !== req.user.id) throw notFound('Booking not found');
    const settings = await getSettings();
    const pay = await query("SELECT * FROM payments WHERE booking_id=$1 AND status='approved' ORDER BY created_at", [row.id]);
    const rv = (await query('SELECT * FROM reviews WHERE booking_id=$1', [row.id])).rows[0];
    const linked = (await query('SELECT id, ref, pickup_at, status, return_of, total FROM bookings WHERE group_id=$1 AND id<>$2', [row.group_id, row.id])).rows;
    res.json({
      booking: serializeBooking(row, { cancelWindowHours: settings.cancelWindowHours }),
      payments: pay.rows.map(serializePayment),
      linked: linked.map((l) => ({ id: l.id, ref: l.ref, pickupAt: l.pickup_at, status: l.status, isReturn: !!l.return_of, total: l.total })),
      review: rv ? { journeyRating: rv.journey_rating, cabRating: rv.cab_rating, driverRating: rv.driver_rating, comment: rv.comment, createdAt: rv.created_at } : null,
    });
  }),
);

/** ID-59: printable receipt data. Owner only (staff get theirs through /staff/bookings/:id/receipt). */
router.get(
  '/:id/receipt',
  ...customerOnly,
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Booking not found');
    const row = await loadBookingRow(null, req.params.id);
    if (!row || row.customer_id !== req.user.id) throw notFound('Booking not found');
    res.json({ receipt: await buildReceipt(row, req.user) });
  }),
);

/* ---------- cancel and amend (R10, ID-62, ID-63) ---------- */

async function ownedBooking(req) {
  if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Booking not found');
  const row = await loadBookingRow(null, req.params.id);
  if (!row || row.customer_id !== req.user.id) throw notFound('Booking not found');
  return row;
}

const amendSchema = z.object({
  pickup: z.string({ error: 'Pickup location is required' }).trim().max(200).default(''),
  destination: z.string().trim().max(200).optional().default(''),
  pickupAt: z.string({ error: 'Choose a date and time' }).min(1, 'Choose a date and time'),
  passengers: z.coerce.number({ error: 'Enter the number of passengers' }).int().min(1, 'Enter at least 1 passenger').max(8, 'We carry up to 8 passengers in one cab'),
  luggage: z.coerce.number().int().min(0).max(12).optional(),
  hours: z.coerce.number().int().optional(),
  packageCode: optionalText(30),
  sizeCode: z.string({ error: 'Choose a cab size' }).min(1, 'Choose a cab size'),
});

router.post(
  '/:id/cancel',
  ...customerOnly,
  body(z.object({ reason: z.string().trim().max(300).optional() })),
  wrap(async (req, res) => {
    await ownedBooking(req);
    const out = await tx((db) => cancelBooking(db, { id: req.params.id, actor: req.user, reason: req.body.reason || null }));
    res.json({
      booking: serializeBooking(out.booking, { cancelWindowHours: out.settings.cancelWindowHours }),
      refund: out.refund ? serializePayment(out.refund) : null,
    });
  }),
);

/** Preview an amendment: availability + price difference, nothing is saved. */
router.post(
  '/:id/amend/preview',
  ...customerOnly,
  body(amendSchema),
  wrap(async (req, res) => {
    const row = await ownedBooking(req);
    const settings = await getSettings();
    if (!serializeBooking(row, { cancelWindowHours: settings.cancelWindowHours }).modifiable) {
      return res.status(409).json({ error: { code: 'too_late', message: `Bookings can only be changed up to ${settings.cancelWindowHours} hours before pickup. Please call us on 020 7000 0000.` } });
    }
    const plan = await planAmendment(null, row, req.body);
    res.json({
      available: plan.available,
      keepsCab: plan.keepsCab,
      alternatives: plan.alternatives,
      oldTotal: plan.oldTotal,
      newTotal: plan.newTotal,
      difference: plan.difference,
      price: plan.quote,
      distanceMiles: plan.journey.distance.miles,
      pickupAt: plan.journey.pickupAt,
    });
  }),
);

router.post(
  '/:id/amend',
  ...customerOnly,
  body(amendSchema),
  wrap(async (req, res) => {
    await ownedBooking(req);
    const out = await tx((db) => amendBooking(db, { id: req.params.id, actor: req.user, input: req.body }));
    res.json({
      booking: serializeBooking(out.booking, { cancelWindowHours: out.settings.cancelWindowHours }),
      difference: out.plan.difference,
      settlement: out.settlement ? serializePayment(out.settlement) : null,
    });
  }),
);
