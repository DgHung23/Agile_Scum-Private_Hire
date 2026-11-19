import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { managerOnly } from '../middleware/auth.js';
import { body, wrap } from '../middleware/validate.js';
import { audit } from '../services/audit.js';
import { serializePackage, serializeService, serializeSize } from './catalog.js';

/**
 * ID-76 manage prices and ID-52 surcharges (Manager only). Business rules are data, so prices change without a
 * deployment, and every change is audited.
 */
export const router = Router();

const SURCHARGE_KEYS = {
  night_surcharge_pct: [0, 100],
  zone_surcharge_gbp: [0, 50],
  weather_surcharge_pct: [0, 100],
  min_fare_gbp: [0, 50],
};

router.get(
  '/pricing',
  ...managerOnly,
  wrap(async (_req, res) => {
    const [services, sizes, packages, settings] = await Promise.all([
      query('SELECT * FROM services ORDER BY sort'),
      query('SELECT * FROM cab_sizes ORDER BY sort'),
      query('SELECT * FROM hire_packages ORDER BY sort'),
      query('SELECT key, value, description FROM settings WHERE key = ANY($1)', [Object.keys(SURCHARGE_KEYS)]),
    ]);
    res.json({
      services: services.rows.map(serializeService),
      sizes: sizes.rows.map(serializeSize),
      packages: packages.rows.map(serializePackage),
      surcharges: settings.rows.map((r) => ({ key: r.key, value: Number(r.value), description: r.description, range: SURCHARGE_KEYS[r.key] })),
    });
  }),
);

const money = (max) => z.coerce.number({ error: 'Enter an amount' }).min(0, 'Cannot be negative').max(max, `At most ${max}`);

const pricingSchema = z.object({
  services: z
    .array(
      z.object({
        code: z.string(),
        baseFare: money(500).optional(),
        perMile: money(50).optional(),
        minFare: money(1000).optional(),
        extraFee: money(500).optional(),
        hourlyRate: money(500).nullable().optional(),
      }),
    )
    .optional(),
  sizes: z.array(z.object({ code: z.string(), multiplier: z.coerce.number().min(0.5, 'At least 0.5').max(5, 'At most 5') })).optional(),
  packages: z.array(z.object({ code: z.string(), price: money(5000) })).optional(),
  surcharges: z.record(z.string(), z.coerce.number()).optional(),
});

router.put(
  '/pricing',
  ...managerOnly,
  body(pricingSchema),
  wrap(async (req, res) => {
    const d = req.body;
    const fields = {};
    for (const [k, v] of Object.entries(d.surcharges || {})) {
      const r = SURCHARGE_KEYS[k];
      if (!r) fields[`surcharges.${k}`] = 'This value cannot be changed here';
      else if (v < r[0] || v > r[1]) fields[`surcharges.${k}`] = `Enter a value from ${r[0]} to ${r[1]}`;
    }
    if (Object.keys(fields).length) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'Please check the highlighted fields', fields } });
    }
    await tx(async (db) => {
      for (const s of d.services || []) {
        const { rows } = await db.query(
          `UPDATE services SET base_fare=COALESCE($2, base_fare), per_mile=COALESCE($3, per_mile), min_fare=COALESCE($4, min_fare),
                  extra_fee=COALESCE($5, extra_fee), hourly_rate=CASE WHEN is_hourly THEN COALESCE($6, hourly_rate) ELSE hourly_rate END
            WHERE code=$1 RETURNING code`,
          [s.code, s.baseFare ?? null, s.perMile ?? null, s.minFare ?? null, s.extraFee ?? null, s.hourlyRate ?? null],
        );
        if (rows[0]) await audit(db, req, 'pricing.service', 'service', s.code, s);
      }
      for (const z2 of d.sizes || []) {
        const { rowCount } = await db.query('UPDATE cab_sizes SET multiplier=$2 WHERE code=$1', [z2.code, z2.multiplier]);
        if (rowCount) await audit(db, req, 'pricing.size', 'cab_size', z2.code, z2);
      }
      for (const p of d.packages || []) {
        const { rowCount } = await db.query('UPDATE hire_packages SET price=$2 WHERE code=$1', [p.code, p.price]);
        if (rowCount) await audit(db, req, 'pricing.package', 'package', p.code, p);
      }
      for (const [k, v] of Object.entries(d.surcharges || {})) {
        await db.query('UPDATE settings SET value=$2 WHERE key=$1', [k, String(v)]);
        await audit(db, req, 'pricing.surcharge', 'setting', k, { value: v });
      }
    });
    res.json({ ok: true });
  }),
);
