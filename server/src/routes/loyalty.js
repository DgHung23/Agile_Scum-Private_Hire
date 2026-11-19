import { Router } from 'express';
import { NOT_TRIP } from '../services/availability.js';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { customerOnly, managerOnly } from '../middleware/auth.js';
import { body, queryOf, wrap } from '../middleware/validate.js';
import { HttpError, badRequest } from '../errors.js';
import { generateCode, normCode, resolveCoupon, sendOffer, serializeOffer, tierFor } from '../services/offers.js';

export const customerRouter = Router(); // /offers
export const staffRouter = Router(); // /staff

/* ---------------- customer: my offers and code check (US10.4) ---------------- */

customerRouter.get(
  '/mine',
  ...customerOnly,
  wrap(async (req, res) => {
    const { rows } = await query(
      `SELECT o.* FROM coupons o
        WHERE o.active AND o.expires_at > now()
          AND (o.open OR EXISTS (SELECT 1 FROM customer_coupons r WHERE r.offer_id = o.id AND r.user_id = $1))
          AND NOT EXISTS (SELECT 1 FROM coupon_redemptions x WHERE x.offer_id = o.id AND x.user_id = $1)
        ORDER BY o.expires_at ASC`,
      [req.user.id],
    );
    res.json({ offers: rows.map(serializeOffer) });
  }),
);

customerRouter.post(
  '/validate',
  ...customerOnly,
  body(z.object({ code: z.string({ error: 'Enter an offer code' }).trim().min(1, 'Enter an offer code').max(30) })),
  wrap(async (req, res) => {
    const o = await resolveCoupon(null, req.body.code, req.user.id);
    res.json({ valid: true, offer: serializeOffer(o) });
  }),
);

/* ---------------- staff: offers (US10.3) ---------------- */

const LOYAL_SQL = `
  SELECT u.id, u.full_name, u.email, u.created_at, u.marketing_consent,
         count(b.id) FILTER (WHERE b.status NOT IN ${NOT_TRIP})::int AS trips,
         COALESCE(sum(b.total) FILTER (WHERE b.status NOT IN ${NOT_TRIP}), 0) AS spend,
         max(b.pickup_at) FILTER (WHERE b.status NOT IN ${NOT_TRIP}) AS last_trip,
         mode() WITHIN GROUP (ORDER BY s.label) FILTER (WHERE b.status NOT IN ${NOT_TRIP}) AS favourite_service,
         mode() WITHIN GROUP (ORDER BY z.label) FILTER (WHERE b.status NOT IN ${NOT_TRIP}) AS favourite_size
    FROM users u
    LEFT JOIN bookings b ON b.customer_id = u.id
    LEFT JOIN services s ON s.code = b.service_code
    LEFT JOIN cab_sizes z ON z.code = b.size_code
   WHERE u.role = 'customer' AND u.is_active
   GROUP BY u.id`;

const serializeLoyal = (r) => ({
  id: r.id,
  fullName: r.full_name,
  email: r.email,
  trips: r.trips,
  spend: Math.round(Number(r.spend) * 100) / 100,
  lastTrip: r.last_trip,
  favouriteService: r.favourite_service,
  favouriteSize: r.favourite_size,
  tier: tierFor(r.trips),
  memberSince: r.created_at,
  marketingConsent: r.marketing_consent,
});

const offerCreate = z.object({
  code: z.string().trim().max(20).regex(/^[A-Za-z0-9]*$/, 'Use letters and numbers only').optional(),
  title: z.string({ error: 'Describe the offer' }).trim().min(3, 'Describe the offer').max(150),
  amount: z.coerce.number({ error: 'Enter an amount from 1 to 50 pounds' }).min(1, 'Enter an amount from 1 to 50 pounds').max(50, 'Enter an amount from 1 to 50 pounds'),
  expiresOn: z.string({ error: 'Choose an expiry date' }).regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose an expiry date'),
  customerIds: z.array(z.string().uuid()).min(1, 'Choose at least one customer').max(500),
});

const expiryTimestamp = async (db, date) => {
  const { rows } = await db.query("SELECT (($1::date + 1)::timestamp AT TIME ZONE 'Europe/London') AS ts, ($1::date >= (now() AT TIME ZONE 'Europe/London')::date) AS ok", [date]);
  if (!rows[0].ok) throw badRequest('The expiry date must be today or later', { expiresOn: 'The expiry date must be today or later' });
  return rows[0].ts;
};

staffRouter.get(
  '/offers',
  ...managerOnly,
  wrap(async (_req, res) => {
    const { rows } = await query(
      `SELECT o.*, (SELECT count(*)::int FROM customer_coupons r WHERE r.offer_id = o.id) AS recipients,
              (SELECT count(*)::int FROM coupon_redemptions x WHERE x.offer_id = o.id) AS redemptions
         FROM coupons o ORDER BY o.created_at DESC LIMIT 100`,
    );
    res.json({ offers: rows.map(serializeOffer) });
  }),
);

/** Create an offer code and email it to the chosen customers. */
staffRouter.post(
  '/offers',
  ...managerOnly,
  body(offerCreate),
  wrap(async (req, res) => {
    const d = req.body;
    const code = d.code ? normCode(d.code) : generateCode();
    if (d.code && code.length < 4) throw badRequest('Codes need at least 4 characters', { code: 'Codes need at least 4 characters' });
    const out = await tx(async (db) => {
      const expires = await expiryTimestamp(db, d.expiresOn);
      let offer;
      try {
        offer = (await db.query('INSERT INTO coupons (code, title, amount, expires_at, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *', [code, d.title, d.amount, expires, req.user.id])).rows[0];
      } catch (e) {
        if (e.code === '23505') throw new HttpError(409, 'That offer code already exists. Choose another.', 'duplicate', { code: 'That offer code already exists.' });
        throw e;
      }
      const { rows: custs } = await db.query(
        `SELECT l.* FROM (${LOYAL_SQL}) l WHERE l.id = ANY($1::uuid[]) AND l.marketing_consent`,
        [d.customerIds],
      );
      if (!custs.length) throw badRequest('None of the chosen customers accept offers', { customerIds: 'Choose customers who opted in to offers' });
      for (const c of custs) await sendOffer(db, offer, { id: c.id, full_name: c.full_name, email: c.email }, c.trips >= 2 ? c.favourite_service : null, req.user.id);
      return { offer, sent: custs.length };
    });
    res.status(201).json({ offer: serializeOffer(out.offer), sent: out.sent });
  }),
);

/**
 * R14: recommend offers from the customer profiles built up over time. Every customer with at least `minTrips`
 * trips gets their own personal code, mentioning the service they book most.
 */
staffRouter.post(
  '/offers/recommend',
  ...managerOnly,
  body(z.object({
    amount: z.coerce.number().min(1).max(50).default(5),
    validDays: z.coerce.number().int().min(1).max(90).default(30),
    minTrips: z.coerce.number().int().min(1).max(100).default(2),
  })),
  wrap(async (req, res) => {
    const { amount, validDays, minTrips } = req.body;
    const sent = await tx(async (db) => {
      const { rows } = await db.query(
        `SELECT l.* FROM (${LOYAL_SQL}) l
          WHERE l.trips >= $1 AND l.marketing_consent
            AND NOT EXISTS (SELECT 1 FROM customer_coupons r JOIN coupons o ON o.id = r.offer_id
                             WHERE r.user_id = l.id AND o.title LIKE 'Loyalty reward%' AND o.expires_at > now())
          ORDER BY l.trips DESC LIMIT 200`,
        [minTrips],
      );
      for (const c of rows) {
        const offer = (
          await db.query(
            `INSERT INTO coupons (code, title, amount, expires_at, created_by)
             VALUES ($1, $2, $3, now() + ($4 || ' days')::interval, $5) RETURNING *`,
            [generateCode(), `Loyalty reward: GBP ${Number(amount).toFixed(2)} off your next ${c.favourite_service || 'journey'}`, amount, String(validDays), req.user.id],
          )
        ).rows[0];
        await sendOffer(db, offer, { id: c.id, full_name: c.full_name, email: c.email }, c.favourite_service, req.user.id);
      }
      return rows.length;
    });
    res.status(201).json({ sent });
  }),
);

staffRouter.post(
  '/offers/:id/deactivate',
  ...managerOnly,
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(404, 'Offer not found', 'not_found');
    await query('UPDATE coupons SET active=false WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }),
);

/* ---------------- manager reports (US10.1, US10.2) ---------------- */

staffRouter.get(
  '/customers-loyalty',
  ...managerOnly,
  queryOf(z.object({ minTrips: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(30) })),
  wrap(async (req, res) => {
    const { rows } = await query(`SELECT l.* FROM (${LOYAL_SQL}) l WHERE l.trips >= $1 ORDER BY l.trips DESC, l.spend DESC LIMIT $2`, [req.query.minTrips, req.query.limit]);
    res.json({ customers: rows.map(serializeLoyal) });
  }),
);

const periodQuery = z.object({ days: z.coerce.number().int().min(1).max(3650).default(90) });

/** US10.1 popular cars and cab sizes */
staffRouter.get(
  '/reports/popular',
  ...managerOnly,
  queryOf(periodQuery),
  wrap(async (req, res) => {
    const days = String(req.query.days);
    const base = `FROM bookings b JOIN cabs c ON c.id = b.cab_id JOIN cab_sizes z ON z.code = b.size_code JOIN services s ON s.code = b.service_code
                  WHERE b.status NOT IN ${NOT_TRIP} AND b.pickup_at >= now() - ($1 || ' days')::interval`;
    const [cabs, models, sizes, services, channels, totals] = await Promise.all([
      query(`SELECT c.id, c.reg, c.make, c.model, z.label AS size, count(*)::int AS bookings, COALESCE(sum(b.total),0) AS revenue ${base} GROUP BY c.id, z.label ORDER BY bookings DESC, revenue DESC LIMIT 10`, [days]),
      query(`SELECT c.make, c.model, count(*)::int AS bookings, COALESCE(sum(b.total),0) AS revenue ${base} GROUP BY c.make, c.model ORDER BY bookings DESC LIMIT 8`, [days]),
      query(`SELECT z.label AS size, z.seats, count(*)::int AS bookings, COALESCE(sum(b.total),0) AS revenue ${base} GROUP BY z.label, z.seats, z.sort ORDER BY z.sort`, [days]),
      query(`SELECT s.label AS service, count(*)::int AS bookings, COALESCE(sum(b.total),0) AS revenue ${base} GROUP BY s.label ORDER BY bookings DESC`, [days]),
      query(`SELECT b.channel, count(*)::int AS bookings, COALESCE(sum(b.total),0) AS revenue ${base} GROUP BY b.channel ORDER BY bookings DESC`, [days]),
      query(`SELECT count(*)::int AS bookings, COALESCE(sum(b.total),0) AS revenue ${base}`, [days]),
    ]);
    const money = (r) => ({ ...r, revenue: Math.round(Number(r.revenue) * 100) / 100 });
    res.json({
      days: Number(days),
      totals: money(totals.rows[0]),
      topCabs: cabs.rows.map(money),
      topModels: models.rows.map(money),
      bySize: sizes.rows.map(money),
      byService: services.rows.map(money),
      byChannel: channels.rows.map(money),
    });
  }),
);
