import crypto from 'node:crypto';
import { query } from '../db.js';
import { HttpError } from '../errors.js';
import { sendEmail } from './notify.js';
import { config } from '../config.js';

/*
 * Coupons (report Table 17 and Figure F3; stories ID-71, ID-72, ID-73).
 * - A coupon is a fixed amount off (no percentage coupons), applied after the 15% programme discount.
 * - One coupon per booking, one use per coupon per account, checked on the server.
 * - A customer's wallet ("My coupons") holds the coupons sent to them (table customer_coupons).
 * - Open coupons (for example a public campaign) can be used by any customer who types the code.
 */

const invalid = (msg) => new HttpError(400, msg, 'invalid_offer', { offerCode: msg });

export const normCode = (c) => String(c || '').trim().toUpperCase().replace(/\s+/g, '');

export function generateCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return 'PH' + Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Check a coupon for a customer (ID-73). Errors are field errors on `offerCode`.
 * Coupons that belong to someone else look the same as coupons that do not exist.
 */
export async function resolveCoupon(db, code, userId) {
  const run = db ? db.query.bind(db) : query;
  const c = normCode(code);
  if (!c) throw invalid('Enter a coupon code');
  const { rows } = await run('SELECT * FROM coupons WHERE code=$1 AND active', [c]);
  const o = rows[0];
  if (!o) throw invalid('That coupon code is not valid. Check it and try again.');
  if (!o.open) {
    const r = await run('SELECT 1 FROM customer_coupons WHERE offer_id=$1 AND user_id=$2', [o.id, userId]);
    if (!r.rowCount) throw invalid('That coupon code is not valid. Check it and try again.');
  }
  if (new Date(o.expires_at).getTime() < Date.now()) throw invalid('That coupon has expired.');
  const used = await run('SELECT 1 FROM coupon_redemptions WHERE offer_id=$1 AND user_id=$2', [o.id, userId]);
  if (used.rowCount) throw invalid('You have already used that coupon.');
  return o;
}

export const serializeOffer = (o) => ({
  id: o.id,
  code: o.code,
  title: o.title,
  amount: Number(o.amount),
  expiresAt: o.expires_at,
  open: o.open,
  active: o.active,
  recipients: o.recipients ?? undefined,
  redemptions: o.redemptions ?? undefined,
  createdAt: o.created_at,
});

const fmtDay = (d) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }).format(new Date(d));

/** Email the coupon to one customer (ID-72). `favourite` personalises the text from their profile. */
export function offerEmail(offer, user, favourite = null) {
  const amount = Number(offer.amount).toFixed(2);
  return {
    subject: `GBP ${amount} off your next journey - coupon ${offer.code}`,
    body:
      `Hello ${user.full_name},\n\n` +
      `${offer.title}\n\n` +
      (favourite ? `We noticed you often book ${favourite}, so we thought you would like this.\n\n` : '') +
      `Your coupon: ${offer.code} (it is already in My coupons)\n` +
      `Value: GBP ${amount} off, after your 15% online discount\n` +
      `Valid until: ${fmtDay(offer.expires_at)}\n\n` +
      `Choose it when you review your booking: ${config.publicUrl}/book\n\n` +
      'You receive offers because you opted in. You can turn them off in Your account.\n\n' +
      'The Private Hire Cars team',
  };
}

/** Put the coupon in the customer's wallet and email it. */
export async function sendOffer(db, offer, user, favourite, sentBy) {
  await db.query('INSERT INTO customer_coupons (offer_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [offer.id, user.id]);
  await sendEmail({ userId: user.id, to: user.email, kind: 'offer', sentBy, ...offerEmail(offer, user, favourite) }, db);
}

export const tierFor = (trips) => (trips >= 10 ? 'Gold' : trips >= 5 ? 'Silver' : trips >= 2 ? 'Bronze' : 'New');
