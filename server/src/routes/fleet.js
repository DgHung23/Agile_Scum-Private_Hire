import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { staffOnly } from '../middleware/auth.js';
import { body, queryOf, wrap } from '../middleware/validate.js';
import { badRequest, HttpError, notFound } from '../errors.js';
import { phoneSchema } from '../schemas.js';
import { bookingWindow, findAvailableCabs, findAvailableDrivers } from '../services/availability.js';

export const router = Router();
router.use(...staffOnly);

const uuid = z.string().uuid();
const checkId = (id) => {
  if (!uuid.safeParse(id).success) throw notFound();
};

/* ---------------- cabs (US9.6) ---------------- */

const cabSchema = z.object({
  reg: z
    .string({ required_error: 'Registration number is required' })
    .trim()
    .min(2, 'Registration number is required')
    .max(10, 'Registration number is too long')
    .regex(/^[A-Za-z0-9 ]+$/, 'Use letters and numbers only')
    .transform((s) => s.toUpperCase().replace(/\s+/g, ' ')),
  make: z.string({ required_error: 'Make is required' }).trim().min(1, 'Make is required').max(40),
  model: z.string({ required_error: 'Model is required' }).trim().min(1, 'Model is required').max(40),
  colour: z.string({ required_error: 'Colour is required' }).trim().min(1, 'Colour is required').max(30),
  sizeCode: z.string({ required_error: 'Choose a cab size' }).min(1, 'Choose a cab size'),
  active: z.boolean().optional(),
});

const serializeCab = (c) => ({
  id: c.id,
  reg: c.reg,
  make: c.make,
  model: c.model,
  colour: c.colour,
  sizeCode: c.size_code,
  sizeLabel: c.size_label,
  seats: c.seats,
  active: c.active,
  upcomingBookings: c.upcoming ?? 0,
});

const CAB_SELECT = `
  SELECT c.*, s.label AS size_label, s.seats,
         (SELECT count(*) FROM bookings b WHERE b.cab_id = c.id AND b.status <> 'cancelled' AND b.end_at > now()) AS upcoming
    FROM cabs c JOIN cab_sizes s ON s.code = c.size_code`;

const cabList = z.object({
  q: z.string().trim().max(40).optional(),
  size: z.string().optional(),
  active: z.enum(['true', 'false']).optional(),
});

router.get(
  '/cabs',
  queryOf(cabList),
  wrap(async (req, res) => {
    const { q, size, active } = req.query;
    const { rows } = await query(
      `${CAB_SELECT}
        WHERE ($1::text IS NULL OR c.reg ILIKE '%' || $1 || '%' OR c.make ILIKE '%' || $1 || '%' OR c.model ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR c.size_code = $2)
          AND ($3::boolean IS NULL OR c.active = $3)
        ORDER BY c.active DESC, s.seats, c.reg`,
      [q || null, size || null, active === undefined ? null : active === 'true'],
    );
    res.json({ cabs: rows.map(serializeCab) });
  }),
);

async function assertSize(sizeCode) {
  const r = await query('SELECT 1 FROM cab_sizes WHERE code = $1', [sizeCode]);
  if (!r.rowCount) throw badRequest('Choose a valid cab size', { sizeCode: 'Choose a valid cab size' });
}

const dupReg = (e) => {
  if (e?.code === '23505') {
    return new HttpError(409, 'A cab with that registration number already exists.', 'duplicate', {
      reg: 'A cab with that registration number already exists.',
    });
  }
  return e;
};

router.post(
  '/cabs',
  body(cabSchema),
  wrap(async (req, res) => {
    const d = req.body;
    await assertSize(d.sizeCode);
    try {
      const { rows } = await query(
        'INSERT INTO cabs (reg, make, model, colour, size_code, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [d.reg, d.make, d.model, d.colour, d.sizeCode, d.active ?? true],
      );
      const { rows: out } = await query(`${CAB_SELECT} WHERE c.id = $1`, [rows[0].id]);
      res.status(201).json({ cab: serializeCab(out[0]) });
    } catch (e) {
      throw dupReg(e);
    }
  }),
);

router.patch(
  '/cabs/:id',
  body(cabSchema),
  wrap(async (req, res) => {
    checkId(req.params.id);
    const d = req.body;
    await assertSize(d.sizeCode);
    const existing = await query('SELECT * FROM cabs WHERE id = $1', [req.params.id]);
    if (!existing.rowCount) throw notFound('Cab not found');
    if (d.active === false && existing.rows[0].active) {
      const up = await query(
        "SELECT count(*)::int AS n FROM bookings WHERE cab_id = $1 AND status <> 'cancelled' AND end_at > now()",
        [req.params.id],
      );
      if (up.rows[0].n > 0) {
        throw new HttpError(
          409,
          `This cab has ${up.rows[0].n} upcoming booking(s). Reassign or cancel them before deactivating the cab.`,
          'has_bookings',
        );
      }
    }
    try {
      await query(
        `UPDATE cabs SET reg=$1, make=$2, model=$3, colour=$4, size_code=$5, active=COALESCE($6, active), updated_at=now()
          WHERE id=$7`,
        [d.reg, d.make, d.model, d.colour, d.sizeCode, d.active ?? null, req.params.id],
      );
    } catch (e) {
      throw dupReg(e);
    }
    const { rows } = await query(`${CAB_SELECT} WHERE c.id = $1`, [req.params.id]);
    res.json({ cab: serializeCab(rows[0]) });
  }),
);

/* ---------------- drivers (US9.7) ---------------- */

const driverSchema = z.object({
  fullName: z.string({ required_error: 'Full name is required' }).trim().min(1, 'Full name is required').max(100),
  phone: phoneSchema,
  licenceNo: z
    .string({ required_error: 'Licence number is required' })
    .trim()
    .min(3, 'Licence number is required')
    .max(30)
    .transform((s) => s.toUpperCase()),
  active: z.boolean().optional(),
});

const serializeDriver = (d) => ({
  id: d.id,
  fullName: d.full_name,
  phone: d.phone,
  licenceNo: d.licence_no,
  active: d.active,
  upcomingBookings: d.upcoming ?? 0,
});

const DRIVER_SELECT = `
  SELECT d.*, (SELECT count(*) FROM bookings b WHERE b.driver_id = d.id AND b.status <> 'cancelled' AND b.end_at > now()) AS upcoming
    FROM drivers d`;

const dupLicence = (e) => {
  if (e?.code === '23505') {
    return new HttpError(409, 'A driver with that licence number already exists.', 'duplicate', {
      licenceNo: 'A driver with that licence number already exists.',
    });
  }
  return e;
};

router.get(
  '/drivers',
  queryOf(z.object({ q: z.string().trim().max(40).optional(), active: z.enum(['true', 'false']).optional() })),
  wrap(async (req, res) => {
    const { q, active } = req.query;
    const { rows } = await query(
      `${DRIVER_SELECT}
        WHERE ($1::text IS NULL OR d.full_name ILIKE '%' || $1 || '%' OR d.licence_no ILIKE '%' || $1 || '%')
          AND ($2::boolean IS NULL OR d.active = $2)
        ORDER BY d.active DESC, d.full_name`,
      [q || null, active === undefined ? null : active === 'true'],
    );
    res.json({ drivers: rows.map(serializeDriver) });
  }),
);

router.post(
  '/drivers',
  body(driverSchema),
  wrap(async (req, res) => {
    const d = req.body;
    try {
      const { rows } = await query(
        'INSERT INTO drivers (full_name, phone, licence_no, active) VALUES ($1,$2,$3,$4) RETURNING id',
        [d.fullName, d.phone, d.licenceNo, d.active ?? true],
      );
      const out = await query(`${DRIVER_SELECT} WHERE d.id = $1`, [rows[0].id]);
      res.status(201).json({ driver: serializeDriver(out.rows[0]) });
    } catch (e) {
      throw dupLicence(e);
    }
  }),
);

router.patch(
  '/drivers/:id',
  body(driverSchema),
  wrap(async (req, res) => {
    checkId(req.params.id);
    const d = req.body;
    const existing = await query('SELECT * FROM drivers WHERE id = $1', [req.params.id]);
    if (!existing.rowCount) throw notFound('Driver not found');
    if (d.active === false && existing.rows[0].active) {
      const up = await query(
        "SELECT count(*)::int AS n FROM bookings WHERE driver_id = $1 AND status <> 'cancelled' AND end_at > now()",
        [req.params.id],
      );
      if (up.rows[0].n > 0) {
        throw new HttpError(
          409,
          `This driver has ${up.rows[0].n} upcoming job(s). Reassign them before deactivating the driver.`,
          'has_bookings',
        );
      }
    }
    try {
      await query(
        'UPDATE drivers SET full_name=$1, phone=$2, licence_no=$3, active=COALESCE($4, active), updated_at=now() WHERE id=$5',
        [d.fullName, d.phone, d.licenceNo, d.active ?? null, req.params.id],
      );
    } catch (e) {
      throw dupLicence(e);
    }
    const out = await query(`${DRIVER_SELECT} WHERE d.id = $1`, [req.params.id]);
    res.json({ driver: serializeDriver(out.rows[0]) });
  }),
);

/* ---------------- availability lookup (US5.1 / US9.4 data) ---------------- */

const availQuery = z.object({
  start: z.string().datetime({ offset: true, message: 'Start must be a valid date and time' }),
  durationMinutes: z.coerce.number().int().min(15).max(24 * 60).default(60),
  size: z.string().optional(),
});

router.get(
  '/availability',
  queryOf(availQuery),
  wrap(async (req, res) => {
    const { start, end } = bookingWindow(req.query.start, req.query.durationMinutes);
    const [cabs, drivers] = await Promise.all([
      findAvailableCabs(null, { start, end, sizeCode: req.query.size || null }),
      findAvailableDrivers(null, { start, end }),
    ]);
    res.json({
      window: { start, end },
      cabs: cabs.map((c) => serializeCab(c)),
      drivers: drivers.map(serializeDriver),
    });
  }),
);
