import crypto from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { forbidden, HttpError, unauthorized } from '../errors.js';
import { getNumber } from '../services/settings.js';
import { wrap } from './validate.js';

/*
 * ID-13: server-side sessions.
 * - The web app gets the session id in an HttpOnly, SameSite=Lax cookie (JavaScript can never read it).
 * - Apps (the future mobile app, the test suite) send the same id as `Authorization: Bearer <id>`.
 * - Only a SHA-256 hash is stored. A session ends after 30 minutes without activity (setting), or 12 hours in total,
 *   or at logout.
 */
export const SESSION_COOKIE = 'ph_sid';
const ABSOLUTE_HOURS = 12;
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

export const STAFF_ROLES = ['staff', 'manager']; // handle bookings and customers (Manager inherits Call Centre Staff)
export const PORTAL_ROLES = ['staff', 'manager', 'admin', 'driver']; // sign in from the staff sign-in page

export const serializeUser = (u) => ({
  id: u.id,
  role: u.role,
  email: u.email,
  fullName: u.full_name,
  phone: u.phone,
  addressLine: u.address_line,
  city: u.city,
  postcode: u.postcode,
  notifyPref: u.notify_pref,
  marketingConsent: u.marketing_consent,
  emailVerified: u.email_verified,
  hasSecretWord: !!u.secret_word_hash,
  refundLimit: u.refund_limit,
  signupChannel: u.signup_channel,
  createdAt: u.created_at,
});

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function cookieHeader(value, maxAgeSeconds) {
  const parts = [`${SESSION_COOKIE}=${value}`, 'Path=/api', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (config.forceHttps) parts.push('Secure');
  return parts.join('; ');
}

/** Create a session after a successful login. The id goes into the cookie; apps also get it in the body. */
export async function startSession(req, res, user, db) {
  const run = db ? db.query.bind(db) : query;
  const id = crypto.randomBytes(32).toString('base64url');
  await run(
    `INSERT INTO sessions (id_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1,$2, now() + make_interval(hours => $3), $4, $5)`,
    [hash(id), user.id, ABSOLUTE_HOURS, req.ip || null, (req.headers['user-agent'] || '').slice(0, 200)],
  );
  res.setHeader('Set-Cookie', cookieHeader(id, ABSOLUTE_HOURS * 3600));
  return id;
}

export const clearSessionCookie = (res) => res.setHeader('Set-Cookie', cookieHeader('', 0));

/** Only apps (header X-Client: app) receive the session id in the JSON body; the browser keeps it in the cookie. */
export const sessionBody = (req, id) => (req.headers['x-client'] === 'app' ? { token: id } : {});

function sessionIdFrom(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return { id: header.slice(7), via: 'bearer' };
  const c = readCookie(req, SESSION_COOKIE);
  return c ? { id: c, via: 'cookie' } : null;
}

async function loadSession(req) {
  const s = sessionIdFrom(req);
  if (!s) return { user: null, reason: 'none' };
  const idle = await getNumber('session_idle_minutes', 30);
  const { rows } = await query(
    `SELECT s.id_hash, s.last_seen_at, s.expires_at, s.revoked_at,
            (s.last_seen_at < now() - make_interval(mins => $2)) AS idle, (s.expires_at < now()) AS expired,
            u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = $1`,
    [hash(s.id), idle],
  );
  const r = rows[0];
  if (!r || r.revoked_at || !r.is_active) return { user: null, reason: 'invalid' };
  if (r.idle || r.expired) {
    await query('UPDATE sessions SET revoked_at = now() WHERE id_hash = $1', [r.id_hash]);
    return { user: null, reason: 'expired' };
  }
  // Refresh the idle timer (at most once a minute to keep writes low).
  await query(
    "UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1 AND last_seen_at < now() - interval '1 minute'",
    [r.id_hash],
  );
  req.sessionHash = r.id_hash;
  req.sessionVia = s.via;
  return { user: r, reason: null };
}

/** Requires a live session; loads the current user row (so role changes and deactivation apply at once). */
export const authenticate = wrap(async (req, _res, next) => {
  const { user, reason } = await loadSession(req);
  if (!user) {
    if (reason === 'expired') {
      throw new HttpError(401, 'Your session ended after 30 minutes without activity. Please log in again.', 'session_expired');
    }
    throw unauthorized();
  }
  req.user = user;
  next();
});

/** Like authenticate, but anonymous requests continue with req.user undefined (fare estimates, enquiries). */
export const optionalAuth = wrap(async (req, _res, next) => {
  const { user } = await loadSession(req);
  if (user) req.user = user;
  next();
});

/** Ends the current session (logout). */
export async function endSession(req) {
  const s = sessionIdFrom(req);
  if (s) await query('UPDATE sessions SET revoked_at = now() WHERE id_hash = $1 AND revoked_at IS NULL', [hash(s.id)]);
}

/** Ends every session of a user except (optionally) the current one - after a password change or reset. */
export async function endOtherSessions(userId, keepHash = null, db) {
  const run = db ? db.query.bind(db) : query;
  await run('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id_hash IS DISTINCT FROM $2', [
    userId,
    keepHash,
  ]);
}

/**
 * Cross-site request forgery guard for cookie sessions: a state-changing request that relies on the cookie must carry
 * the custom header X-PH-Client, which a foreign site cannot set without a CORS preflight we refuse.
 */
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if ((req.headers.authorization || '').startsWith('Bearer ')) return next();
  if (!readCookie(req, SESSION_COOKIE)) return next();
  if (!req.headers['x-ph-client']) return next(forbidden('Request blocked: missing client header.'));
  next();
}

export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };

/** Call Centre Staff and Managers (Manager inherits staff). Admin does not handle bookings (separation of duties). */
export const staffOnly = [authenticate, requireRole(...STAFF_ROLES)];
export const managerOnly = [authenticate, requireRole('manager')];
export const adminOnly = [authenticate, requireRole('admin')];
export const driverOnly = [authenticate, requireRole('driver')];
export const customerOnly = [authenticate, requireRole('customer')];
