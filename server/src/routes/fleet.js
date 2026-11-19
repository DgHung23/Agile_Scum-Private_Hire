import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requireRole, staffOnly } from '../middleware/auth.js';
import { body, queryOf, wrap } from '../middleware/validate.js';
import { audit } from '../services/audit.js';

const manager = requireRole('manager');
import { badRequest, HttpError, notFound } from '../errors.js';
import { phoneSchema } from '../schemas.js';
import { bookingWindow, findAvailableCabs, findAvailableDrivers } from '../services/availability.js';
import { computeQuote } from '../services/pricing.js';
import { getSettings, prepareJourney } from '../services/booking.js';

export const router = Router();
router.use(...staffOnly);

const uuid = z.string().uuid();
const checkId = (id) => {
  if (!uuid.safeParse(id).success) throw notFound();
};

/* ---------------- cabs (US9.6) ---------------- */

const cabSchema = z.object({
  reg: z
    .string({ error: 'Registration number is required' })
    .trim()
    .min(2, 'Registration number is required')
    .max(10, 'Registration number is too long')
    .regex(/^[A-Za-z0-9 ]+$/, 'Use letters and numbers only')
    .transform((s) => s.toUpperCase().replace(/\s+/g, ' ')),
  make: z.string({ error: 'Make is required' }).trim().min(1, 'Make is required').max(40),
  model: z.string({ error: 'Model is required' }).trim().min(1, 'Model is required').max(40),
  colour: z.string({ error: 'Colour is required' }).trim().min(1, 'Colour is required').max(30),
  sizeCode: z.string({ error: 'Choose a cab size' }).min(1, 'Choose a cab size'),
  active: z.boolean().optional(),
  wheelchairAccessible: z.boolean().optional(), // ID-39, ID-65
});

/* ---------- ID-65, ID-66: documents with expiry dates ---------- */
export const DOC_TYPES = {
  cab: { phv_vehicle_licence: 'PHV vehicle licence', insurance: 'Insurance', mot: 'MOT certificate' },
  driver: { phv_driver_licence: 'PHV driver licence', driving_licence: 'Driving licence' },
};
const SOON_DAYS = 30;
const serializeDocs = (docs = [], type) => {
  const today = new Date(new Date().toISOString().slice(0, 10));
  return Object.entries(DOC_TYPES[type]).map(([k, label]) => {
    const d = docs.find((x) => x.doc_type === k);
    const expires = d ? new Date(d.expires_on) : null;
    const days = expires ? Math.round((expires - today) / 86400_000) : null;
    return { type: k, label, reference: d?.reference || null, expiresOn: d ? d.expires_on : null, missing: !d, expired: !!d && days < 0, expiringSoon: !!d && days >= 0 && days <= SOON_DAYS };
  });
};
const docsFor = async (type, ids) => {
  if (!ids.length) return {};
  const { rows } = await query("SELECT *, to_char(expires_on, 'YYYY-MM-DD') AS expires_on FROM documents WHERE owner_type=$1 AND owner_id = ANY($2)", [type, ids]);
  const out = {};
  for (const r of rows) (out[r.owner_id] ||= []).push(r);
  return out;
};

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
  wheelchairAccessible: c.wheelchair_accessible,
  status: c.active ? c.status : 'deactivated', // Figure F7: available, unavailable, deactivated
  statusReason: c.status_reason,
  upcomingBookings: c.upcoming ?? 0,
  documents: serializeDocs(c.docs, 'cab'),
});
const withCabDocs = async (rows) => {
  const docs = await docsFor('cab', rows.map((r) => r.id));
  return rows.map((r) => serializeCab({ ...r, docs: docs[r.id] }));
};

const CAB_SELECT = `
  SELECT c.*, s.label AS size_label, s.seats,
         (SELECT count(*) FROM bookings b WHERE b.cab_id = c.id AND b.status NOT IN ('cancelled','company_cancelled','abandoned') AND b.end_at > now()) AS upcoming
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
    res.json({ cabs: await withCabDocs(rows) });
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
  manager,
  body(cabSchema),
  wrap(async (req, res) => {
    const d = req.body;
    await assertSize(d.sizeCode);
    try {
      const { rows } = await query(
        'INSERT INTO cabs (reg, make, model, colour, size_code, active, wheelchair_accessible) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [d.reg, d.make, d.model, d.colour, d.sizeCode, d.active ?? true, !!d.wheelchairAccessible],
      );
      await audit(null, req, 'fleet.cab.create', 'cab', rows[0].id, { reg: d.reg });
      const { rows: out } = await query(`${CAB_SELECT} WHERE c.id = $1`, [rows[0].id]);
      res.status(201).json({ cab: (await withCabDocs(out))[0] });
    } catch (e) {
      throw dupReg(e);
    }
  }),
);

router.patch(
  '/cabs/:id',
  manager,
  body(cabSchema),
  wrap(async (req, res) => {
    checkId(req.params.id);
    const d = req.body;
    await assertSize(d.sizeCode);
    const existing = await query('SELECT * FROM cabs WHERE id = $1', [req.params.id]);
    if (!existing.rowCount) throw notFound('Cab not found');
    if (d.active === false && existing.rows[0].active) {
      const up = await query(
        "SELECT count(*)::int AS n FROM bookings WHERE cab_id = $1 AND status NOT IN ('cancelled','company_cancelled','abandoned') AND end_at > now()",
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
        `UPDATE cabs SET reg=$1, make=$2, model=$3, colour=$4, size_code=$5, active=COALESCE($6, active),
                wheelchair_accessible=COALESCE($8, wheelchair_accessible), updated_at=now()
          WHERE id=$7`,
        [d.reg, d.make, d.model, d.colour, d.sizeCode, d.active ?? null, req.params.id, d.wheelchairAccessible ?? null],
      );
      await audit(null, req, 'fleet.cab.update', 'cab', req.params.id, { reg: d.reg, active: d.active });
    } catch (e) {
      throw dupReg(e);
    }
    const { rows } = await query(`${CAB_SELECT} WHERE c.id = $1`, [req.params.id]);
    res.json({ cab: (await withCabDocs(rows))[0] });
  }),
);

/** ID-65, N30: mark a vehicle Unavailable (for example after a breakdown) or clear it. Manager only. */
router.patch(
  '/cabs/:id/status',
  manager,
  body(z.object({ status: z.enum(['available', 'unavailable']), reason: z.string().trim().max(200).optional() })),
  wrap(async (req, res) => {
    checkId(req.params.id);
    const r = await query('UPDATE cabs SET status=$2, status_reason=$3, updated_at=now() WHERE id=$1 RETURNING id', [
      req.params.id, req.body.status, req.body.status === 'unavailable' ? req.body.reason || 'Unavailable' : null,
    ]);
    if (!r.rowCount) throw notFound('Cab not found');
    await audit(null, req, 'fleet.cab.status', 'cab', req.params.id, req.body);
    const { rows } = await query(`${CAB_SELECT} WHERE c.id = $1`, [req.params.id]);
    res.json({ cab: (await withCabDocs(rows))[0] });
  }),
);

const docSchema = z.object({
  docType: z.string(),
  reference: z.string().trim().max(40).optional(),
  expiresOn: z.string({ error: 'Choose the expiry date' }).regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the expiry date'),
});

/** ID-65, ID-66: add or renew a document. Manager only. */
const putDocument = (type) =>
  wrap(async (req, res) => {
    checkId(req.params.id);
    if (!DOC_TYPES[type][req.body.docType]) throw badRequest('Choose a document type', { docType: 'Choose a document type' });
    const owner = await query(`SELECT 1 FROM ${type === 'cab' ? 'cabs' : 'drivers'} WHERE id=$1`, [req.params.id]);
    if (!owner.rowCount) throw notFound();
    await query(
      `INSERT INTO documents (owner_type, owner_id, doc_type, reference, expires_on) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (owner_type, owner_id, doc_type) DO UPDATE SET reference=EXCLUDED.reference, expires_on=EXCLUDED.expires_on, updated_at=now()`,
      [type, req.params.id, req.body.docType, req.body.reference || null, req.body.expiresOn],
    );
    await audit(null, req, `fleet.document`, type, req.params.id, req.body);
    const docs = await docsFor(type, [req.params.id]);
    res.json({ documents: serializeDocs(docs[req.params.id], type) });
  });
router.put('/cabs/:id/documents', manager, body(docSchema), putDocument('cab'));
router.put('/drivers/:id/documents', manager, body(docSchema), putDocument('driver'));

/** Documents that have expired or expire within 30 days (shown to the Manager). */
router.get(
  '/documents/expiring',
  wrap(async (_req, res) => {
    const { rows } = await query(
      `SELECT x.*, to_char(x.expires_on, 'YYYY-MM-DD') AS expires_on, (x.expires_on < current_date) AS expired,
              COALESCE(c.reg, d.full_name) AS owner_name
         FROM documents x LEFT JOIN cabs c ON x.owner_type='cab' AND c.id=x.owner_id LEFT JOIN drivers d ON x.owner_type='driver' AND d.id=x.owner_id
        WHERE x.expires_on <= current_date + $1::int AND (c.active OR d.active)
        ORDER BY x.expires_on`,
      [SOON_DAYS],
    );
    res.json({
      documents: rows.map((r) => ({
        ownerType: r.owner_type, ownerId: r.owner_id, ownerName: r.owner_name, type: r.doc_type,
        label: DOC_TYPES[r.owner_type][r.doc_type], expiresOn: r.expires_on, expired: r.expired,
      })),
    });
  }),
);

/* ---------------- drivers (US9.7) ---------------- */

const driverSchema = z.object({
  fullName: z.string({ error: 'Full name is required' }).trim().min(1, 'Full name is required').max(100),
  phone: phoneSchema,
  licenceNo: z
    .string({ error: 'Licence number is required' })
    .trim()
    .min(3, 'Licence number is required')
    .max(30)
    .transform((s) => s.toUpperCase()),
  active: z.boolean().optional(),
  photoUrl: z.string().trim().max(300).regex(/^(https?:\/\/|\/)/, 'Use a web address or a site path').optional().or(z.literal('')),
});

const serializeDriver = (d) => ({
  id: d.id,
  fullName: d.full_name,
  phone: d.phone,
  licenceNo: d.licence_no,
  photoUrl: d.photo_url,
  active: d.active,
  hasLogin: !!d.user_id,
  upcomingBookings: d.upcoming ?? 0,
  documents: serializeDocs(d.docs, 'driver'),
});
const withDriverDocs = async (rows) => {
  const docs = await docsFor('driver', rows.map((r) => r.id));
  return rows.map((r) => serializeDriver({ ...r, docs: docs[r.id] }));
};

const DRIVER_SELECT = `
  SELECT d.*, (SELECT count(*) FROM bookings b WHERE b.driver_id = d.id AND b.status NOT IN ('cancelled','company_cancelled','abandoned') AND b.end_at > now()) AS upcoming
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
    res.json({ drivers: await withDriverDocs(rows) });
  }),
);

router.post(
  '/drivers',
  manager,
  body(driverSchema),
  wrap(async (req, res) => {
    const d = req.body;
    try {
      const { rows } = await query(
        'INSERT INTO drivers (full_name, phone, licence_no, active, photo_url) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [d.fullName, d.phone, d.licenceNo, d.active ?? true, d.photoUrl || null],
      );
      await audit(null, req, 'fleet.driver.create', 'driver', rows[0].id, { licenceNo: d.licenceNo });
      const out = await query(`${DRIVER_SELECT} WHERE d.id = $1`, [rows[0].id]);
      res.status(201).json({ driver: (await withDriverDocs(out.rows))[0] });
    } catch (e) {
      throw dupLicence(e);
    }
  }),
);

router.patch(
  '/drivers/:id',
  manager,
  body(driverSchema),
  wrap(async (req, res) => {
    checkId(req.params.id);
    const d = req.body;
    const existing = await query('SELECT * FROM drivers WHERE id = $1', [req.params.id]);
    if (!existing.rowCount) throw notFound('Driver not found');
    if (d.active === false && existing.rows[0].active) {
      const up = await query(
        "SELECT count(*)::int AS n FROM bookings WHERE driver_id = $1 AND status NOT IN ('cancelled','company_cancelled','abandoned') AND end_at > now()",
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
        'UPDATE drivers SET full_name=$1, phone=$2, licence_no=$3, active=COALESCE($4, active), photo_url=COALESCE($6, photo_url), updated_at=now() WHERE id=$5',
        [d.fullName, d.phone, d.licenceNo, d.active ?? null, req.params.id, d.photoUrl === undefined ? null : d.photoUrl || null],
      );
      await audit(null, req, 'fleet.driver.update', 'driver', req.params.id, { active: d.active });
    } catch (e) {
      throw dupLicence(e);
    }
    const out = await query(`${DRIVER_SELECT} WHERE d.id = $1`, [req.params.id]);
    res.json({ driver: (await withDriverDocs(out.rows))[0] });
  }),
);

/* ---------------- availability lookup (US5.1 / US9.4 data) ---------------- */

const availQuery = z.object({
  start: z.string().datetime({ offset: true, message: 'Start must be a valid date and time' }),
  durationMinutes: z.coerce.number().int().min(15).max(24 * 60).default(60),
  size: z.string().optional(),
  // optional journey: when given, the response includes an estimated price per cab size (US9.4 criterion 2)
  serviceCode: z.string().optional(),
  pickup: z.string().trim().max(200).optional(),
  destination: z.string().trim().max(200).optional(),
  hours: z.coerce.number().int().optional(),
});

router.get(
  '/availability',
  queryOf(availQuery),
  wrap(async (req, res) => {
    let minutes = req.query.durationMinutes;
    let prices = null;
    if (req.query.serviceCode) {
      const settings = await getSettings();
      const j = await prepareJourney(null, {
        serviceCode: req.query.serviceCode,
        pickup: req.query.pickup,
        destination: req.query.destination,
        pickupAt: req.query.start,
        passengers: 1,
        hours: req.query.hours,
      });
      minutes = j.durationMinutes;
      const sizes = (await query('SELECT * FROM cab_sizes ORDER BY sort')).rows;
      prices = Object.fromEntries(
        sizes.map((s) => [
          s.code,
          computeQuote({ service: j.service, size: { ...s, multiplier: Number(s.multiplier) }, miles: j.distance.miles, hours: j.hours, channel: 'phone', onlineDiscountPct: settings.onlineDiscountPct }).total,
        ]),
      );
    }
    const { start, end } = bookingWindow(req.query.start, minutes);
    const [cabs, drivers] = await Promise.all([
      findAvailableCabs(null, { start, end, sizeCode: req.query.size || null }),
      findAvailableDrivers(null, { start, end }),
    ]);
    res.json({
      window: { start, end },
      durationMinutes: minutes,
      cabs: cabs.map((c) => ({ ...serializeCab(c), estimatedPrice: prices ? prices[c.size_code] : null })),
      drivers: drivers.map(serializeDriver),
    });
  }),
);
