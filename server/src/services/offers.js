import crypto from 'node:crypto';
import { query } from '../db.js';
import { HttpError } from '../errors.js';
import { sendEmail } from './notify.js';
import { config } from '../config.js';

const invalid = (msg) => new HttpError(400, msg, 'invalid_offer', { offerCode: msg });

export const normCode = (c) => String(c || '').trim().toUpperCase().replace(/\s+/g, '');

export function generateCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return 'PH' + Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Check an offer code for a customer (US10.4). Errors are field errors on `offerCode`.
 * Codes that belong to someone else look the same as codes that do not exist.
 */
export async function resolveOffer(db, code, userId) {
  const run = db ? db.query.bind(db) : query;
  const c = normCode(code);
  if (!c) throw invalid('Enter an offer code');
  const { rows } = await run('SELECT * FROM offers WHERE code=$1 AND active', [c]);
  const o = rows[0];
  if (!o) throw invalid('That offer code is not valid. Check it and try again.');
  if (!o.open) {
    const r = await run('SELECT 1 FROM offer_recipients WHERE offer_id=$1 AND user_id=$2', [o.id, userId]);
    if (!r.rowCount) throw invalid('That offer code is not valid. Check it and try again.');
  }
  if (new Date(o.expires_at).getTime() < Date.now()) throw invalid('That offer code has expired.');
  const used = await run('SELECT 1 FROM offer_redemptions WHERE offer_id=$1 AND user_id=$2', [o.id, userId]);
  if (used.rowCount) throw invalid('You have already used that offer code.');
  return o;
}

export const serializeOffer = (o) => ({
  id: o.id,
  code: o.code,
  title: o.title,
  discountPct: o.discount_pct,
  expiresAt: o.expires_at,
  open: o.open,
  active: o.active,
  recipients: o.recipients ?? undefined,
  redemptions: o.redemptions ?? undefined,
  createdAt: o.created_at,
});

const fmtDay = (d) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }).format(new Date(d));

/** Email the code to one customer (US10.3 criterion 2). `favourite` personalises the text from their profile. */
export function offerEmail(offer, user, favourite = null) {
  return {
    subject: `${offer.discount_pct}% off your next journey - code ${offer.code}`,
    body:
      `Hello ${user.full_name},\n\n` +
      `${offer.title}\n\n` +
      (favourite ? `We noticed you often book ${favourite}, so we thought you would like this.\n\n` : '') +
      `Your offer code: ${offer.code}\n` +
      `Discount: ${offer.discount_pct}% off, on top of your 15% online discount\n` +
      `Valid until: ${fmtDay(offer.expires_at)}\n\n` +
      `Enter the code when you review your booking: ${config.publicUrl}/book\n\n` +
      'The PrivateHire Cars team',
  };
}

export async function sendOffer(db, offer, user, favourite, sentBy) {
  await db.query('INSERT INTO offer_recipients (offer_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [offer.id, user.id]);
  await sendEmail({ userId: user.id, to: user.email, kind: 'offer', sentBy, ...offerEmail(offer, user, favourite) }, db);
}

export const tierFor = (trips) => (trips >= 10 ? 'Gold' : trips >= 5 ? 'Silver' : trips >= 2 ? 'Bronze' : 'New');
