import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { customerOnly, optionalAuth } from '../middleware/auth.js';
import { body, queryOf, wrap } from '../middleware/validate.js';
import { notFound } from '../errors.js';
import { availabilityBySize } from '../services/availability.js';
import { computeQuote } from '../services/pricing.js';
import {
  createBooking,
  getSettings,
  loadBookingRow,
  prepareJourney,
  serializeBooking,
} from '../services/booking.js';

export const router = Router();

export const journeySchema = z.object({
  serviceCode: z.string({ required_error: 'Choose a service to continue' }).min(1, 'Choose a service to continue'),
  pickup: z.string({ required_error: 'Pickup location is required' }).trim().max(200).default(''),
  destination: z.string().trim().max(200).optional().default(''),
  pickupAt: z.string({ required_error: 'Choose a date and time' }).min(1, 'Choose a date and time'),
  passengers: z.coerce.number({ invalid_type_error: 'Enter the number of passengers' }).int('Enter a whole number').min(1, 'Enter at least 1 passenger').max(16, 'For more than 16 passengers please call us'),
  hours: z.coerce.number().int().optional(),
});

const quoteSchema = journeySchema.extend({
  channel: z.enum(['online', 'phone', 'in_person']).optional(),
});

const createSchema = journeySchema.extend({
  sizeCode: z.string({ required_error: 'Choose a cab size' }).min(1, 'Choose a cab size'),
  notifyPref: z.enum(['email', 'text', 'both']).default('email'),
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

    res.json({
      channel,
      onlineDiscountPct: settings.onlineDiscountPct,
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

/** US3.5: confirm an online booking. Priced and checked again on the server. */
router.post(
  '/',
  ...customerOnly,
  body(createSchema),
  wrap(async (req, res) => {
    const out = await tx((db) =>
      createBooking(db, { customer: req.user, input: req.body, channel: 'online', createdBy: req.user.id }),
    );
    res.status(201).json({ booking: serializeBooking(out.row, { cancelWindowHours: out.settings.cancelWindowHours }) });
  }),
);

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
    res.json({ booking: serializeBooking(row, { cancelWindowHours: settings.cancelWindowHours }) });
  }),
);
