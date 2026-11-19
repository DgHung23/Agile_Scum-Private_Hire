import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { config } from '../config.js';
import { adminOnly, endOtherSessions, serializeUser } from '../middleware/auth.js';
import { body, queryOf, wrap } from '../middleware/validate.js';
import { badRequest, HttpError, notFound } from '../errors.js';
import { emailSchema, passwordSchema, phoneSchema } from '../schemas.js';
import { audit } from '../services/audit.js';
import { sendEmail } from '../services/notify.js';

/**
 * Admin (system administrator): staff accounts and roles (N01), audit log (N03), settings (N04).
 * Admin does not handle bookings or customers (separation of duties, report Table 7).
 */
export const router = Router();
router.use(...adminOnly);

const STAFF_ACCOUNT_ROLES = ['staff', 'manager', 'admin', 'driver'];
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');

/* ---------- N01: staff accounts and roles ---------- */

router.get(
  '/staff',
  wrap(async (_req, res) => {
    const { rows } = await query(
      `SELECT * FROM users WHERE role = ANY($1) ORDER BY is_active DESC, role, full_name`,
      [STAFF_ACCOUNT_ROLES],
    );
    res.json({ staff: rows.map((u) => ({ ...serializeUser(u), isActive: u.is_active, lastLoginAt: u.last_login_at })) });
  }),
);

const createStaffSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required').max(100),
  email: emailSchema,
  phone: phoneSchema,
  role: z.enum(STAFF_ACCOUNT_ROLES, { error: 'Choose a role' }),
  refundLimit: z.coerce.number().min(0).max(100000).nullable().optional(),
  password: passwordSchema.optional().or(z.literal('')),
});

router.post(
  '/staff',
  body(createStaffSchema),
  wrap(async (req, res) => {
    const d = req.body;
    const exists = await query('SELECT 1 FROM users WHERE email=$1', [d.email]);
    if (exists.rowCount) throw new HttpError(409, 'An account with that email already exists.', 'email_taken', { email: 'An account with that email already exists.' });
    const user = await tx(async (db) => {
      // Without an initial password the new member chooses one from a link (valid 24 hours).
      const pw = d.password || crypto.randomBytes(24).toString('base64url');
      const limit = d.role === 'staff' ? (d.refundLimit ?? 50) : d.role === 'manager' ? (d.refundLimit ?? null) : null;
      const { rows } = await db.query(
        `INSERT INTO users (role, email, password_hash, full_name, phone, email_verified, refund_limit, created_by, signup_channel)
         VALUES ($1,$2,$3,$4,$5,true,$6,$7,'in_person') RETURNING *`,
        [d.role, d.email, await bcrypt.hash(pw, 10), d.fullName, d.phone, limit, req.user.id],
      );
      const u = rows[0];
      if (!d.password) {
        const token = crypto.randomBytes(32).toString('base64url');
        await db.query("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '24 hours')", [sha256(token), u.id]);
        await sendEmail(
          {
            userId: u.id,
            to: u.email,
            kind: 'staff_invite',
            subject: 'Your Private Hire Cars staff account',
            body:
              `Hello ${u.full_name},\n\nAn administrator created a ${u.role} account for you.\n` +
              `Choose your password within 24 hours: ${config.publicUrl}/reset-password?token=${token}\n` +
              `Then sign in at ${config.publicUrl}/staff/login\n\nThe Private Hire Cars team`,
            sentBy: req.user.id,
          },
          db,
        );
      }
      await audit(db, req, 'staff.create', 'user', u.id, { role: u.role, email: u.email });
      return u;
    });
    res.status(201).json({ user: serializeUser(user) });
  }),
);

const updateStaffSchema = z.object({
  role: z.enum(STAFF_ACCOUNT_ROLES).optional(),
  isActive: z.boolean().optional(),
  refundLimit: z.coerce.number().min(0).max(100000).nullable().optional(),
});

router.patch(
  '/staff/:id',
  body(updateStaffSchema),
  wrap(async (req, res) => {
    const { rows: cur } = await query('SELECT * FROM users WHERE id=$1 AND role = ANY($2)', [req.params.id, STAFF_ACCOUNT_ROLES]);
    if (!cur[0]) throw notFound('Staff member not found');
    if (cur[0].id === req.user.id && (req.body.isActive === false || (req.body.role && req.body.role !== 'admin'))) {
      throw badRequest('You cannot remove your own admin access.');
    }
    const user = await tx(async (db) => {
      const { rows } = await db.query(
        `UPDATE users SET role=COALESCE($2, role), is_active=COALESCE($3, is_active),
                refund_limit = CASE WHEN $5 THEN $4 ELSE refund_limit END, updated_at=now()
          WHERE id=$1 RETURNING *`,
        [req.params.id, req.body.role ?? null, req.body.isActive ?? null, req.body.refundLimit ?? null, 'refundLimit' in req.body],
      );
      if (req.body.isActive === false) await endOtherSessions(req.params.id, null, db);
      await audit(db, req, 'staff.update', 'user', req.params.id, req.body);
      return rows[0];
    });
    res.json({ user: { ...serializeUser(user), isActive: user.is_active } });
  }),
);

/* ---------- N03: audit log ---------- */

const auditQuery = z.object({
  action: z.string().trim().max(60).optional(),
  staffId: z.string().uuid().optional(),
  targetId: z.string().trim().max(80).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

router.get(
  '/audit',
  queryOf(auditQuery),
  wrap(async (req, res) => {
    const q = req.query;
    const where = [];
    const args = [];
    const add = (sql, v) => {
      args.push(v);
      where.push(sql.replace('?', `$${args.length}`));
    };
    if (q.action) add('action ILIKE ?', `${q.action}%`);
    if (q.staffId) add('staff_id = ?', q.staffId);
    if (q.targetId) add('target_id = ?', q.targetId);
    if (q.from) add('at >= ?::date', q.from);
    if (q.to) add("at < (?::date + interval '1 day')", q.to);
    args.push(q.limit);
    const { rows } = await query(
      `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC LIMIT $${args.length}`,
      args,
    );
    res.json({
      entries: rows.map((r) => ({
        id: r.id,
        at: r.at,
        staffId: r.staff_id,
        staffName: r.staff_name,
        staffRole: r.staff_role,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        details: r.details,
        ip: r.ip,
      })),
    });
  }),
);

/* ---------- N04: settings ---------- */

// Only these keys can be changed, each with its allowed range.
const EDITABLE = {
  online_discount_pct: [0, 50],
  cancel_window_hours: [1, 72],
  staff_refund_limit: [0, 1000],
  session_idle_minutes: [5, 240],
  lockout_failures: [3, 20],
  lockout_minutes: [5, 120],
  retention_months: [12, 120],
};

router.get(
  '/settings',
  wrap(async (_req, res) => {
    const { rows } = await query('SELECT * FROM settings ORDER BY key');
    res.json({
      settings: rows.map((r) => ({ key: r.key, value: r.value, description: r.description, editable: r.key in EDITABLE, range: EDITABLE[r.key] || null })),
    });
  }),
);

router.put(
  '/settings',
  body(z.record(z.string(), z.coerce.number())),
  wrap(async (req, res) => {
    const fields = {};
    for (const [k, v] of Object.entries(req.body)) {
      const range = EDITABLE[k];
      if (!range) fields[k] = 'This setting cannot be changed here';
      else if (v < range[0] || v > range[1]) fields[k] = `Enter a value from ${range[0]} to ${range[1]}`;
    }
    if (Object.keys(fields).length) throw badRequest('Please check the highlighted settings', fields);
    await tx(async (db) => {
      for (const [k, v] of Object.entries(req.body)) {
        const { rows } = await db.query('SELECT value FROM settings WHERE key=$1', [k]);
        await db.query('UPDATE settings SET value=$2 WHERE key=$1', [k, String(v)]);
        await audit(db, req, 'settings.update', 'setting', k, { from: rows[0]?.value, to: String(v) });
      }
      if ('staff_refund_limit' in req.body) {
        await db.query("UPDATE users SET refund_limit=$1 WHERE role='staff'", [req.body.staff_refund_limit]);
      }
    });
    res.json({ ok: true });
  }),
);
