import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { customerOnly, staffOnly } from '../middleware/auth.js';
import { body, queryOf, wrap } from '../middleware/validate.js';
import { HttpError, notFound } from '../errors.js';
import { loadBookingRow } from '../services/booking.js';
import { audit } from '../services/audit.js';

export const router = Router(); // mounted at /bookings
export const staffRouter = Router(); // mounted at /staff
staffRouter.use(...staffOnly);

const star = (label) =>
  z.coerce.number({ error: `Rate the ${label} from 1 to 5` }).int(`Rate the ${label} from 1 to 5`).min(1, `Rate the ${label} from 1 to 5`).max(5, `Rate the ${label} from 1 to 5`);

const reviewSchema = z.object({
  journeyRating: star('journey'),
  cabRating: star('minicab'),
  driverRating: star('driver'),
  comment: z.string().trim().max(1000, 'Please keep your comment under 1000 characters').optional(),
});

/**
 * US7.1: review a COMPLETED journey: three separate star ratings (journey, minicab, driver) and a comment.
 * One review per booking, enforced by a unique constraint.
 */
router.post(
  '/:id/review',
  ...customerOnly,
  body(reviewSchema),
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Booking not found');
    const row = await loadBookingRow(null, req.params.id);
    if (!row || row.customer_id !== req.user.id) throw notFound('Booking not found');
    if (row.status !== 'completed') {
      throw new HttpError(409, 'You can review a journey once it has been completed.', 'not_completed');
    }
    try {
      const { rows } = await query(
        `INSERT INTO reviews (booking_id, customer_id, cab_id, driver_id, journey_rating, cab_rating, driver_rating, comment)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [row.id, req.user.id, row.cab_id, row.driver_id, req.body.journeyRating, req.body.cabRating, req.body.driverRating, req.body.comment || null],
      );
      const r = rows[0];
      res.status(201).json({ review: { journeyRating: r.journey_rating, cabRating: r.cab_rating, driverRating: r.driver_rating, comment: r.comment, createdAt: r.created_at } });
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, 'You have already reviewed this journey.', 'already_reviewed');
      throw e;
    }
  }),
);

/* ---------------- staff view (US7.2) ---------------- */

const avg = (n) => (n === null ? null : Math.round(Number(n) * 10) / 10);

staffRouter.get(
  '/reviews/summary',
  wrap(async (_req, res) => {
    const drivers = await query(
      `SELECT d.id, d.full_name, count(r.id)::int AS reviews, avg(r.driver_rating) AS rating, avg(r.journey_rating) AS journey
         FROM drivers d JOIN reviews r ON r.driver_id = d.id GROUP BY d.id ORDER BY rating ASC, reviews DESC`,
    );
    const cabs = await query(
      `SELECT c.id, c.reg, c.make, c.model, count(r.id)::int AS reviews, avg(r.cab_rating) AS rating
         FROM cabs c JOIN reviews r ON r.cab_id = c.id GROUP BY c.id ORDER BY rating ASC, reviews DESC`,
    );
    const overall = (await query('SELECT count(*)::int AS n, avg(journey_rating) AS j, avg(cab_rating) AS c, avg(driver_rating) AS d FROM reviews')).rows[0];
    res.json({
      overall: { reviews: overall.n, journey: avg(overall.j), cab: avg(overall.c), driver: avg(overall.d) },
      drivers: drivers.rows.map((d) => ({ id: d.id, name: d.full_name, reviews: d.reviews, rating: avg(d.rating), journeyRating: avg(d.journey), needsAttention: Number(d.rating) < 3.5 })),
      cabs: cabs.rows.map((c) => ({ id: c.id, reg: c.reg, name: `${c.make} ${c.model}`, reviews: c.reviews, rating: avg(c.rating), needsAttention: Number(c.rating) < 3.5 })),
    });
  }),
);

staffRouter.get(
  '/reviews',
  queryOf(z.object({ driverId: z.string().uuid().optional(), cabId: z.string().uuid().optional(), maxRating: z.coerce.number().int().min(1).max(5).optional() })),
  wrap(async (req, res) => {
    const { driverId, cabId, maxRating } = req.query;
    const { rows } = await query(
      `SELECT r.*, b.ref, b.pickup, b.destination, u.full_name AS customer_name, d.full_name AS driver_name, c.reg AS cab_reg, c.make AS cab_make, c.model AS cab_model
         FROM reviews r JOIN bookings b ON b.id = r.booking_id JOIN users u ON u.id = r.customer_id
         LEFT JOIN drivers d ON d.id = r.driver_id LEFT JOIN cabs c ON c.id = r.cab_id
        WHERE ($1::uuid IS NULL OR r.driver_id = $1) AND ($2::uuid IS NULL OR r.cab_id = $2)
          AND ($3::int IS NULL OR LEAST(r.journey_rating, r.cab_rating, r.driver_rating) <= $3)
        ORDER BY r.created_at DESC LIMIT 100`,
      [driverId || null, cabId || null, maxRating || null],
    );
    res.json({
      reviews: rows.map((r) => ({
        id: r.id,
        bookingRef: r.ref,
        route: `${r.pickup} to ${r.destination}`,
        customerName: r.customer_name,
        driverName: r.driver_name,
        cab: r.cab_reg ? `${r.cab_reg} ${r.cab_make} ${r.cab_model}` : null,
        journeyRating: r.journey_rating,
        cabRating: r.cab_rating,
        driverRating: r.driver_rating,
        comment: r.comment,
        hidden: r.hidden,
        hiddenReason: r.hidden_reason,
        createdAt: r.created_at,
      })),
    });
  }),
);

/** ID-60: staff hide abusive review text (the star ratings stay). */
staffRouter.post(
  '/reviews/:id/hide',
  body(z.object({ hidden: z.boolean(), reason: z.string().trim().max(200).optional() })),
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(404, 'Review not found', 'not_found');
    const { rows } = await query(
      'UPDATE reviews SET hidden=$2, hidden_by=$3, hidden_reason=$4 WHERE id=$1 RETURNING id',
      [req.params.id, req.body.hidden, req.user.id, req.body.hidden ? req.body.reason || 'Abusive language' : null],
    );
    if (!rows[0]) throw new HttpError(404, 'Review not found', 'not_found');
    await audit(null, req, req.body.hidden ? 'review.hide' : 'review.show', 'review', req.params.id, { reason: req.body.reason });
    res.json({ ok: true });
  }),
);
