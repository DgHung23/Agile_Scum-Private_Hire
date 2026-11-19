import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { queryOf, wrap } from '../middleware/validate.js';

export const router = Router();

export const serializeService = (s) => ({
  code: s.code,
  label: s.label,
  description: s.description,
  baseFare: s.base_fare,
  perMile: s.per_mile,
  hourlyRate: s.hourly_rate,
  extraFee: s.extra_fee,
  minFare: s.min_fare,
  minHours: s.min_hours,
  maxHours: s.max_hours,
  isHourly: s.is_hourly,
  needsAirport: s.needs_airport,
});

export const serializeSize = (s) => ({ code: s.code, label: s.label, seats: s.seats, multiplier: s.multiplier });

/** Public reference data used by the booking screens (and the future mobile app). */
router.get(
  '/services',
  wrap(async (_req, res) => {
    const { rows } = await query('SELECT * FROM services WHERE active ORDER BY sort');
    res.json({ services: rows.map(serializeService) });
  }),
);

router.get(
  '/cab-sizes',
  wrap(async (_req, res) => {
    const { rows } = await query('SELECT * FROM cab_sizes ORDER BY sort');
    res.json({ cabSizes: rows.map(serializeSize) });
  }),
);

const locQuery = z.object({ q: z.string().trim().max(60).optional(), limit: z.coerce.number().int().min(1).max(50).default(12) });

router.get(
  '/locations',
  queryOf(locQuery),
  wrap(async (req, res) => {
    const { q, limit } = req.query;
    const { rows } = await query(
      `SELECT name, kind FROM locations
        WHERE $1::text IS NULL OR name ILIKE '%' || $1 || '%'
        ORDER BY (CASE WHEN $1::text IS NOT NULL AND name ILIKE $1 || '%' THEN 0 ELSE 1 END), name
        LIMIT $2`,
      [q || null, limit],
    );
    res.json({ locations: rows });
  }),
);

router.get(
  '/settings',
  wrap(async (_req, res) => {
    const { rows } = await query(
      "SELECT key, value FROM settings WHERE key IN ('online_discount_pct','cancel_window_hours','company_name')",
    );
    res.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
  }),
);
