import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { config } from '../config.js';
import { body, wrap } from '../middleware/validate.js';
import {
  authenticate,
  clearSessionCookie,
  endOtherSessions,
  endSession,
  optionalAuth,
  PORTAL_ROLES,
  serializeUser,
  sessionBody,
  startSession,
} from '../middleware/auth.js';
import { badRequest, HttpError } from '../errors.js';
import {
  emailSchema,
  passwordSchema,
  changePasswordSchema,
  loginSchema,
  normalisePostcode,
  profileUpdateSchema,
  registerSchema,
  secretWordSchema,
} from '../schemas.js';
import { sendEmail, templates } from '../services/notify.js';
import { getNumber } from '../services/settings.js';

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');

export const router = Router();

const limiter = (limit, windowMs) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !config.isProd, // tests and local demos are not throttled
    message: { error: { code: 'rate_limited', message: 'Too many attempts. Please try again in a few minutes.' } },
  });
const loginLimiter = limiter(30, 15 * 60 * 1000);
const registerLimiter = limiter(10, 60 * 60 * 1000); // ID-11 criterion 5, Definition of Done line 13

// Used so "no such user" takes as long as "wrong password" (prevents account enumeration by timing)
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-1', 10);
const BAD_LOGIN = 'Incorrect email or password.';
const IP_FAILURE_LIMIT = 30; // failures from one IP address across all accounts in the window

/** One-time email link (verify address or unlock account). Only the hash is stored. */
async function issueEmailToken(db, userId, purpose, hours) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4))`,
    [sha256(token), userId, purpose, hours],
  );
  return token;
}

async function sendVerifyEmail(db, user) {
  const token = await issueEmailToken(db, user.id, 'verify', 48);
  const mail = templates.verifyEmail(user, `${config.publicUrl}/verify-email?token=${token}`);
  await sendEmail({ userId: user.id, to: user.email, kind: 'verify_email', ...mail }, db);
}

/* ---------- ID-11 + ID-12: register, confirmation email, verify the address ---------- */

/**
 * The reply is the same for a new and an existing email (red-team row 1), so nobody can use this form to find out who
 * has an account. The owner of an existing account gets an email instead.
 */
router.post(
  '/register',
  registerLimiter,
  body(registerSchema),
  wrap(async (req, res) => {
    const d = req.body;
    const hash = await bcrypt.hash(d.password, 10);
    const secretHash = d.secretWord ? await bcrypt.hash(d.secretWord.toLowerCase(), 10) : null;
    await tx(async (db) => {
      const { rows: existing } = await db.query('SELECT * FROM users WHERE email = $1', [d.email]);
      if (existing[0]) {
        const mail = templates.registerAttempt(existing[0]);
        await sendEmail({ userId: existing[0].id, to: existing[0].email, kind: 'register_attempt', ...mail }, db);
        return;
      }
      const { rows } = await db.query(
        `INSERT INTO users (role, email, password_hash, full_name, phone, address_line, city, postcode, notify_pref,
                            marketing_consent, secret_word_hash, email_verified)
         VALUES ('customer',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false) RETURNING *`,
        [
          d.email,
          hash,
          d.fullName,
          d.phone,
          d.addressLine,
          d.city,
          normalisePostcode(d.postcode),
          d.notifyPref || 'email',
          !!d.marketingConsent,
          secretHash,
        ],
      );
      const u = rows[0];
      const mail = templates.welcome(u);
      await sendEmail({ userId: u.id, to: u.email, kind: 'welcome', ...mail }, db);
      await sendVerifyEmail(db, u);
    });
    res.status(201).json({
      message:
        'Thank you. If this email is new to us, your account is ready: we have sent a confirmation email with a link to verify your address. Log in to continue.',
    });
  }),
);

router.post(
  '/verify-email',
  body(z.object({ token: z.string().min(20, 'This link is not valid') })),
  wrap(async (req, res) => {
    const ok = await tx(async (db) => {
      const { rows } = await db.query(
        "SELECT * FROM email_tokens WHERE token_hash=$1 AND purpose='verify' AND used_at IS NULL AND expires_at > now() FOR UPDATE",
        [sha256(req.body.token)],
      );
      if (!rows[0]) return false;
      await db.query('UPDATE email_tokens SET used_at=now() WHERE token_hash=$1', [rows[0].token_hash]);
      await db.query('UPDATE users SET email_verified=true, updated_at=now() WHERE id=$1', [rows[0].user_id]);
      return true;
    });
    if (!ok) throw new HttpError(400, 'This verification link is invalid or has expired. Log in and ask for a new one.', 'bad_token');
    res.json({ ok: true, message: 'Your email address is verified. You can now book online.' });
  }),
);

router.post(
  '/verify-email/resend',
  authenticate,
  wrap(async (req, res) => {
    if (req.user.email_verified) return res.json({ ok: true, message: 'Your email address is already verified.' });
    await tx((db) => sendVerifyEmail(db, req.user));
    res.json({ ok: true, message: `We have sent a new link to ${req.user.email}.` });
  }),
);

/* ---------- ID-13: log in with lockout by account and IP address ---------- */

async function lockState(email, ip) {
  const failures = await getNumber('lockout_failures', 5);
  const minutes = await getNumber('lockout_minutes', 15);
  const { rows } = await query(
    `SELECT
       (SELECT count(*) FROM login_attempts a
         WHERE a.email=$1 AND a.ip=$2 AND NOT a.success AND a.at > now() - make_interval(mins => $3)
           AND a.at > COALESCE((SELECT max(at) FROM login_attempts s WHERE s.email=$1 AND s.ip=$2 AND s.success), '-infinity')
       )::int AS pair_failures,
       (SELECT count(*) FROM login_attempts a WHERE a.ip=$2 AND NOT a.success AND a.at > now() - make_interval(mins => $3))::int AS ip_failures`,
    [email, ip, minutes],
  );
  return { ...rows[0], failures, minutes, locked: rows[0].pair_failures >= failures || rows[0].ip_failures >= IP_FAILURE_LIMIT };
}

const lockedError = (minutes) =>
  new HttpError(
    429,
    `Too many failed attempts. Please wait ${minutes} minutes, or use the unlock link we emailed to the account owner.`,
    'account_locked',
  );

async function checkCredentials(req, allowedRoles) {
  const { email, password } = req.body;
  const ip = req.ip || 'unknown';
  const before = await lockState(email, ip);
  if (before.locked) throw lockedError(before.minutes);

  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok || !user.is_active) {
    await query('INSERT INTO login_attempts (email, ip, success) VALUES ($1,$2,false)', [email, ip]);
    if (user) await query('UPDATE users SET failed_logins = failed_logins + 1 WHERE id=$1', [user.id]);
    const after = await lockState(email, ip);
    if (after.pair_failures === after.failures && user) {
      // Just locked: tell the owner and give them a link to unlock straight away.
      await tx(async (db) => {
        await db.query('UPDATE users SET locked_until = now() + make_interval(mins => $2) WHERE id=$1', [user.id, after.minutes]);
        const token = await issueEmailToken(db, user.id, 'unlock', 1);
        const mail = templates.accountLocked(user, `${config.publicUrl}/unlock?token=${token}`, after.minutes);
        await sendEmail({ userId: user.id, to: user.email, kind: 'account_locked', ...mail }, db);
      });
    }
    if (after.locked) throw lockedError(after.minutes);
    throw new HttpError(401, BAD_LOGIN, 'bad_credentials');
  }
  if (!allowedRoles.includes(user.role)) {
    // Correct password but wrong door: tell them where to go.
    throw new HttpError(
      403,
      user.role === 'customer'
        ? 'This sign-in is for staff only. Customers can log in from the main login page.'
        : 'Staff accounts sign in from the Staff sign-in page.',
      'wrong_portal',
    );
  }
  await query('INSERT INTO login_attempts (email, ip, success) VALUES ($1,$2,true)', [email, ip]);
  await query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id=$1', [user.id]);
  return user;
}

async function login(req, res, roles) {
  const user = await checkCredentials(req, roles);
  const id = await startSession(req, res, user);
  res.json({ user: serializeUser(user), ...sessionBody(req, id) });
}

router.post('/login', loginLimiter, body(loginSchema), wrap((req, res) => login(req, res, ['customer'])));

/** ID-18: separate sign-in for Call Centre Staff, Managers, Admins and Drivers. */
router.post('/staff-login', loginLimiter, body(loginSchema), wrap((req, res) => login(req, res, PORTAL_ROLES)));

/** ID-13: the unlock link from the lock email clears the failures for that account. */
router.post(
  '/unlock',
  body(z.object({ token: z.string().min(20, 'This link is not valid') })),
  wrap(async (req, res) => {
    const ok = await tx(async (db) => {
      const { rows } = await db.query(
        "SELECT t.*, u.email FROM email_tokens t JOIN users u ON u.id=t.user_id WHERE token_hash=$1 AND purpose='unlock' AND used_at IS NULL AND expires_at > now() FOR UPDATE",
        [sha256(req.body.token)],
      );
      if (!rows[0]) return false;
      await db.query('UPDATE email_tokens SET used_at=now() WHERE token_hash=$1', [rows[0].token_hash]);
      await db.query('DELETE FROM login_attempts WHERE email=$1 AND NOT success', [rows[0].email]);
      await db.query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [rows[0].user_id]);
      return true;
    });
    if (!ok) throw new HttpError(400, 'This unlock link is invalid or has expired.', 'bad_token');
    res.json({ ok: true, message: 'Your account is unlocked. You can log in again.' });
  }),
);

router.get('/me', authenticate, (req, res) => res.json({ user: serializeUser(req.user) }));

/** Page-load check for the web app: 200 with user or null, so a signed-out visitor sees no error. */
router.get('/session', optionalAuth, (req, res) => res.json({ user: req.user ? serializeUser(req.user) : null }));

/** ID-15: edit profile and marketing consent. Changing the email needs the current password (red-team row 3). */
router.patch(
  '/me',
  authenticate,
  body(profileUpdateSchema),
  wrap(async (req, res) => {
    const d = req.body;
    const emailChanged = d.email !== req.user.email.toLowerCase();
    if (emailChanged) {
      const ok = d.currentPassword && (await bcrypt.compare(d.currentPassword, req.user.password_hash));
      if (!ok) {
        throw new HttpError(400, 'Enter your current password to change your email address.', 'password_required', {
          currentPassword: 'Enter your current password to change your email address.',
        });
      }
      const clash = await query('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [d.email, req.user.id]);
      if (clash.rowCount) {
        throw new HttpError(409, 'That email cannot be used. Try a different address.', 'email_taken', {
          email: 'That email cannot be used. Try a different address.',
        });
      }
    }
    const user = await tx(async (db) => {
      const { rows } = await db.query(
        `UPDATE users SET full_name=$1, email=$2, phone=$3, address_line=$4, city=$5, postcode=$6,
                notify_pref=COALESCE($7, notify_pref), marketing_consent=COALESCE($8, marketing_consent),
                email_verified = CASE WHEN $9 THEN false ELSE email_verified END, updated_at=now()
         WHERE id=$10 RETURNING *`,
        [
          d.fullName,
          d.email,
          d.phone,
          d.addressLine,
          d.city,
          normalisePostcode(d.postcode),
          d.notifyPref ?? null,
          d.marketingConsent ?? null,
          emailChanged,
          req.user.id,
        ],
      );
      if (emailChanged) {
        // Confirmation to the OLD address, verification link to the new one.
        const mail = templates.emailChanged(req.user, d.email);
        await sendEmail({ userId: req.user.id, to: req.user.email, kind: 'email_changed', ...mail }, db);
        await sendVerifyEmail(db, rows[0]);
      }
      return rows[0];
    });
    res.json({ user: serializeUser(user) });
  }),
);

/** ID-20: the secret word used to verify the customer on the phone. Never shown back, stored hashed. */
router.put(
  '/me/secret-word',
  authenticate,
  body(z.object({ secretWord: secretWordSchema, currentPassword: z.string().min(1, 'Current password is required') })),
  wrap(async (req, res) => {
    if (!(await bcrypt.compare(req.body.currentPassword, req.user.password_hash))) {
      throw new HttpError(400, 'Your current password is not correct.', 'bad_credentials', {
        currentPassword: 'Your current password is not correct.',
      });
    }
    await query('UPDATE users SET secret_word_hash=$1, updated_at=now() WHERE id=$2', [
      await bcrypt.hash(req.body.secretWord.toLowerCase(), 10),
      req.user.id,
    ]);
    res.json({ ok: true });
  }),
);

/** N02: change password. Other sessions end. */
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
    await endOtherSessions(req.user.id, req.sessionHash);
    await sendEmail({ userId: req.user.id, to: req.user.email, kind: 'password_changed', ...templates.passwordChanged(req.user) });
    res.json({ ok: true });
  }),
);

/** ID-13 criterion 4: the session ends on the server, so the Back button cannot reopen the dashboard. */
router.post(
  '/logout',
  wrap(async (req, res) => {
    await endSession(req);
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

/* ---------- ID-17: reset a forgotten password by email ---------- */

/** Always answers the same way, so nobody can use this to find out who has an account. */
router.post(
  '/forgot',
  loginLimiter,
  body(z.object({ email: emailSchema })),
  wrap(async (req, res) => {
    const { rows } = await query('SELECT * FROM users WHERE email = $1 AND is_active', [req.body.email]);
    const u = rows[0];
    if (u) {
      const token = crypto.randomBytes(32).toString('base64url');
      await query("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')", [sha256(token), u.id]);
      await sendEmail({
        userId: u.id,
        to: u.email,
        kind: 'password_reset',
        ...templates.passwordReset(u, `${config.publicUrl}/reset-password?token=${token}`),
      });
    }
    res.json({ message: 'If that email is registered, we have sent you a link to reset your password.' });
  }),
);

router.post(
  '/reset',
  loginLimiter,
  body(z.object({ token: z.string({ error: 'This reset link is not valid' }).min(20, 'This reset link is not valid'), password: passwordSchema })),
  wrap(async (req, res) => {
    const hash = sha256(req.body.token);
    await tx(async (db) => {
      const { rows } = await db.query(
        'SELECT * FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() FOR UPDATE',
        [hash],
      );
      const r = rows[0];
      if (!r) throw new HttpError(400, 'This reset link is invalid or has expired. Please ask for a new one.', 'bad_token');
      const { rows: users } = await db.query('SELECT * FROM users WHERE id=$1', [r.user_id]);
      await db.query(
        'UPDATE users SET password_hash=$1, failed_logins=0, locked_until=NULL, updated_at=now() WHERE id=$2',
        [await bcrypt.hash(req.body.password, 10), r.user_id],
      );
      await db.query('UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [r.user_id]);
      await db.query('DELETE FROM login_attempts WHERE email=$1 AND NOT success', [users[0].email]);
      await endOtherSessions(r.user_id, null, db);
      await sendEmail({ userId: r.user_id, to: users[0].email, kind: 'password_changed', ...templates.passwordChanged(users[0]) }, db);
    });
    res.json({ ok: true });
  }),
);
