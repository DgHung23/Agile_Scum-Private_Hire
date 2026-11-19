import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { customerOnly, optionalAuth } from '../middleware/auth.js';
import { body, queryOf, wrap } from '../middleware/validate.js';
import { HttpError, notFound } from '../errors.js';
import { resolveOffer } from '../services/offers.js';
import { availabilityBySize } from '../services/availability.js';
import { computeQuote } from '../services/pricing.js';
import { cancelBooking, amendBooking, planAmendment } from '../services/changes.js';
import { paymentSchema, recordDeclined, serializePayment, describeMethod } from '../services/payments.js';
import {
  createBooking,
  getSettings,
  loadBookingRow,
  prepareJourney,
  serializeBooking,
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

export const journeySchema = z.object({
  serviceCode: z.string({ error: 'Choose a service to continue' }).min(1, 'Choose a service to continue'),
  pickup: z.string({ error: 'Pickup location is required' }).trim().max(200).default(''),
  destination: z.string().trim().max(200).optional().default(''),
  pickupAt: z.string({ error: 'Choose a date and time' }).min(1, 'Choose a date and time'),
  passengers: z.coerce.number({ error: 'Enter the number of passengers' }).int('Enter a whole number').min(1, 'Enter at least 1 passenger').max(16, 'For more than 16 passengers please call us'),
  hours: z.coerce.number().int().optional(),
});

const quoteSchema = journeySchema.extend({
  channel: z.enum(['online', 'phone', 'in_person']).optional(),
  offerCode: z.string().trim().max(30).optional(),
});

const createSchema = journeySchema.extend({
  sizeCode: z.string({ error: 'Choose a cab size' }).min(1, 'Choose a cab size'),
  notifyPref: z.enum(['email', 'text', 'both']).default('email'),
  offerCode: z.string().trim().max(30).optional(),
  payment: paymentSchema,
});

/**
 * US5.1 / US5.2 / US3.3 / US3.4: price every cab size for a journey and report how many cabs are free.
 * Public so people can see prices before registering; staff may quote for the phone / in-person channel.
 */
router.post(
  '/quote',
  optionalAuth,
  body(quoteSchema),
  wrap(async (req, res) => {
    const isStaff = req.user && req.user.role !== 'customer';
    const channel = isStaff && req.body.channel ? req.body.channel : 'online';
    const settings = await getSettings();
    const j = await prepareJourney(null, req.body);
    const sizes = (await query('SELECT * FROM cab_sizes ORDER BY sort')).rows;
    const counts = await availabilityBySize(null, j.window);
    let offer = null;
    if (req.body.offerCode) {
      if (!req.user || req.user.role !== 'customer') throw new HttpError(400, 'Log in to use an offer code.', 'invalid_offer', { offerCode: 'Log in to use an offer code.' });
      offer = await resolveOffer(null, req.body.offerCode, req.user.id);
    }

    res.json({
      channel,
      onlineDiscountPct: settings.onlineDiscountPct,
      offer: offer ? { code: offer.code, discountPct: offer.discount_pct, title: offer.title } : null,
      distanceMiles: j.distance.miles,
      distanceSource: j.distance.source,
      durationMinutes: j.durationMinutes,
      pickupAt: j.pickupAt,
      sizes: sizes.map((s) => {
        const fits = s.seats >= j.passengers;
        const price = computeQuote({
          service: j.service,
          size: { ...s, multiplier: Number(s.multiplier) },
          miles: j.distance.miles,
          hours: j.hours,
          channel,
          onlineDiscountPct: settings.onlineDiscountPct,
          offerPct: offer ? offer.discount_pct : 0,
        });
        return {
          code: s.code,
          label: s.label,
          seats: s.seats,
          fitsPassengers: fits,
          available: counts[s.code] || 0,
          price,
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

/** US3.5: confirm an online booking. Priced and checked again on the server. */
router.post(
  '/',
  ...customerOnly,
  requireVerified,
  body(createSchema),
  wrap(async (req, res) => {
    let out;
    try {
      out = await tx((db) =>
        createBooking(db, {
          customer: req.user,
          input: req.body,
          channel: 'online',
          createdBy: req.user.id,
          payment: req.body.payment,
        }),
      );
    } catch (e) {
      // keep an audit record of declined payments even though the booking was rolled back
      if (e.code === 'payment_declined') {
        const q = await quoteTotal(req.body);
        await recordDeclined({ userId: req.user.id, amount: q, method: req.body.payment.method, card: e.card, reason: e.message }).catch(() => {});
      }
      throw e;
    }
    res.status(201).json({
      booking: serializeBooking(out.row, { cancelWindowHours: out.settings.cancelWindowHours }),
      payment: out.payment ? serializePayment(out.payment) : null,
    });
  }),
);

async function quoteTotal(input) {
  try {
    const settings = await getSettings();
    const j = await prepareJourney(null, input);
    const size = (await query('SELECT * FROM cab_sizes WHERE code=$1', [input.sizeCode])).rows[0];
    return computeQuote({ service: j.service, size: { ...size, multiplier: Number(size.multiplier) }, miles: j.distance.miles, hours: j.hours, channel: 'online', onlineDiscountPct: settings.onlineDiscountPct }).total;
  } catch {
    return 0;
  }
}

const listQuery = z.object({ when: z.enum(['upcoming', 'past', 'all']).default('all') });

/** US3.6: my upcoming and past bookings. */
router.get(
  '/',
  ...customerOnly,
  queryOf(listQuery),
  wrap(async (req, res) => {
    const settings = await getSettings();
    const { when } = req.query;
    const { rows } = await query(
      `SELECT b.id FROM bookings b
        WHERE b.customer_id = $1
          AND ($2 = 'all'
               OR ($2 = 'upcoming' AND b.end_at >= now() AND b.status NOT IN ('cancelled','completed'))
               OR ($2 = 'past' AND (b.end_at < now() OR b.status IN ('cancelled','completed'))))
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
    const row = await loadBookingRow(null, req.params.id);
    // Other customers' bookings look exactly like missing ones
    if (!row || row.customer_id !== req.user.id) throw notFound('Booking not found');
    const settings = await getSettings();
    const pay = await query("SELECT * FROM payments WHERE booking_id=$1 AND status='approved' ORDER BY created_at", [row.id]);
    const rv = (await query('SELECT * FROM reviews WHERE booking_id=$1', [row.id])).rows[0];
    res.json({
      booking: serializeBooking(row, { cancelWindowHours: settings.cancelWindowHours }),
      payments: pay.rows.map(serializePayment),
      review: rv ? { journeyRating: rv.journey_rating, cabRating: rv.cab_rating, driverRating: rv.driver_rating, comment: rv.comment, createdAt: rv.created_at } : null,
    });
  }),
);

/** US6.1: printable receipt data. Owner only (staff get theirs through /staff/bookings/:id/receipt). */
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

/* ---------- cancel and amend (R10, US8.1, US8.2) ---------- */

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
  passengers: z.coerce.number({ error: 'Enter the number of passengers' }).int().min(1, 'Enter at least 1 passenger').max(16),
  hours: z.coerce.number().int().optional(),
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
    if (!['confirmed', 'assigned'].includes(row.status) || !serializeBooking(row, { cancelWindowHours: settings.cancelWindowHours }).modifiable) {
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
