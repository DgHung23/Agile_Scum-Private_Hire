import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { query, tx } from '../db.js';
import { config } from '../config.js';
import { body, wrap } from '../middleware/validate.js';
import { authenticate, serializeUser, signToken } from '../middleware/auth.js';
import { badRequest, HttpError } from '../errors.js';
import {
  changePasswordSchema,
  loginSchema,
  normalisePostcode,
  profileUpdateSchema,
  registerSchema,
} from '../schemas.js';
import { sendEmail, templates } from '../services/notify.js';

export const router = Router();

// Brute-force protection (disabled outside production so tests and demos are not throttled)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !config.isProd,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Please try again in a few minutes.' } },
});

// Used so "no such user" takes as long as "wrong password" (prevents account enumeration by timing)
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-1', 10);
const BAD_LOGIN = 'Incorrect email or password.';

/** US1.1 + US1.2: register and send the confirmation email. */
router.post(
  '/register',
  loginLimiter,
  body(registerSchema),
  wrap(async (req, res) => {
    const d = req.body;
    const hash = await bcrypt.hash(d.password, 10);
    const user = await tx(async (db) => {
      const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [d.email]);
      if (exists.rowCount) {
        throw new HttpError(409, 'That email is already registered. Try logging in instead.', 'email_taken', {
          email: 'That email is already registered. Try logging in instead.',
        });
      }
      const { rows } = await db.query(
        `INSERT INTO users (role, email, password_hash, full_name, phone, address_line, city, postcode, notify_pref)
         VALUES ('customer',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [d.email, hash, d.fullName, d.phone, d.addressLine, d.city, normalisePostcode(d.postcode), d.notifyPref || 'email'],
      );
      const u = rows[0];
      const mail = templates.welcome(u);
      await sendEmail({ userId: u.id, to: u.email, kind: 'welcome', ...mail }, db);
      return u;
    });
    res.status(201).json({ user: serializeUser(user), message: 'Account created. We have emailed you a confirmation.' });
  }),
);

async function checkCredentials(email, password, allowedRoles) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok || !user.is_active) throw new HttpError(401, BAD_LOGIN, 'bad_credentials');
  if (!allowedRoles.includes(user.role)) {
    // Correct password but wrong door: tell them where to go (no information about whether the password was right
    // is given to anyone who does not already know it).
    throw new HttpError(
      403,
      user.role === 'customer'
        ? 'This sign-in is for staff only. Customers can log in from the main login page.'
        : 'Staff accounts sign in from the Staff sign-in page.',
      'wrong_portal',
    );
  }
  return user;
}

/** US1.3: customer login. Same message for unknown email and wrong password. */
router.post(
  '/login',
  loginLimiter,
  body(loginSchema),
  wrap(async (req, res) => {
    const user = await checkCredentials(req.body.email, req.body.password, ['customer']);
    res.json({ token: signToken(user), user: serializeUser(user) });
  }),
);

/** US9.1: separate staff login. */
router.post(
  '/staff-login',
  loginLimiter,
  body(loginSchema),
  wrap(async (req, res) => {
    const user = await checkCredentials(req.body.email, req.body.password, ['staff', 'admin']);
    res.json({ token: signToken(user), user: serializeUser(user) });
  }),
);

router.get('/me', authenticate, (req, res) => res.json({ user: serializeUser(req.user) }));

/** US1.5: edit profile. Same validation as registration. */
router.patch(
  '/me',
  authenticate,
  body(profileUpdateSchema),
  wrap(async (req, res) => {
    const d = req.body;
    const clash = await query('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [d.email, req.user.id]);
    if (clash.rowCount) {
      throw new HttpError(409, 'That email is already registered to another account.', 'email_taken', {
        email: 'That email is already registered to another account.',
      });
    }
    const { rows } = await query(
      `UPDATE users SET full_name=$1, email=$2, phone=$3, address_line=$4, city=$5, postcode=$6,
              notify_pref=COALESCE($7, notify_pref), updated_at=now()
       WHERE id=$8 RETURNING *`,
      [d.fullName, d.email, d.phone, d.addressLine, d.city, normalisePostcode(d.postcode), d.notifyPref ?? null, req.user.id],
    );
    res.json({ user: serializeUser(rows[0]) });
  }),
);

router.post(
  '/change-password',
  authenticate,
  body(changePasswordSchema),
  wrap(async (req, res) => {
    const ok = await bcrypt.compare(req.body.currentPassword, req.user.password_hash);
    if (!ok) {
      throw new HttpError(400, 'Your current password is not correct.', 'bad_credentials', {
        currentPassword: 'Your current password is not correct.',
      });
    }
    if (req.body.currentPassword === req.body.newPassword) {
      throw badRequest('Choose a new password that is different from your current one.', {
        newPassword: 'Choose a password different from your current one.',
      });
    }
    await query('UPDATE users SET password_hash=$1, updated_at=now() WHERE id=$2', [
      await bcrypt.hash(req.body.newPassword, 10),
      req.user.id,
    ]);
    res.json({ ok: true });
  }),
);

// Logout is stateless (JWT): the client discards the token. Endpoint exists so apps have one call to make.
router.post('/logout', (_req, res) => res.json({ ok: true }));
