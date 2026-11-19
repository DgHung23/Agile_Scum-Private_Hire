import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';
import { forbidden, unauthorized } from '../errors.js';
import { wrap } from './validate.js';

export const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

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
  signupChannel: u.signup_channel,
  createdAt: u.created_at,
});

/** Requires a valid Bearer token; loads the current user row (so role changes/deactivation apply at once). */
export const authenticate = wrap(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw unauthorized();
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    throw unauthorized('Your session has expired. Please log in again.');
  }
  const { rows } = await query('SELECT * FROM users WHERE id = $1 AND is_active', [payload.sub]);
  if (!rows[0]) throw unauthorized('Your session has expired. Please log in again.');
  req.user = rows[0];
  next();
});

export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };

export const staffOnly = [authenticate, requireRole('staff', 'admin')];
export const adminOnly = [authenticate, requireRole('admin')];
export const customerOnly = [authenticate, requireRole('customer')];
