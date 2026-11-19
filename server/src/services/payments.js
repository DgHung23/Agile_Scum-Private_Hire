import crypto from 'node:crypto';
import { z } from 'zod';
import { query } from '../db.js';
import { HttpError, badRequest } from '../errors.js';

/**
 * Payment service (SIMULATED).
 *  - Card validation is real (Luhn, expiry, CVV length, brand) and is what a real checkout does before calling a bank.
 *  - `visaCheck` stands in for the bank's VISA Check system (R7). Test cards below choose the outcome.
 *  - Card numbers / CVV are never stored; only brand, last4, expiry and an opaque token.
 *
 * Test cards:  4242 4242 4242 4242 Visa OK | 5555 5555 5555 4444 Mastercard OK | 3782 822463 10005 Amex OK
 *              4000 0000 0000 0002 declined | 4000 0000 0000 9995 insufficient funds | 4000 0000 0000 9979 lost card
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (s) => String(s ?? '').replace(/[\s-]/g, '');

export function detectBrand(number) {
  const n = digits(number);
  if (/^4/.test(n)) return 'visa';
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/.test(n)) return 'mastercard';
  if (/^3[47]/.test(n)) return 'amex';
  return null;
}

export function luhnValid(number) {
  const n = digits(number);
  if (!/^\d{12,19}$/.test(n)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = n.length - 1; i >= 0; i--) {
    let d = Number(n[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export const BRAND_LABEL = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express' };

const normYear = (y) => (Number(y) < 100 ? 2000 + Number(y) : Number(y));

/** Returns { field: message } for anything wrong with the card (US5.3 criterion 1). Empty object = valid. */
export function validateCard(card, now = new Date()) {
  const errors = {};
  const n = digits(card.number);
  const brand = detectBrand(n);
  if (!n) errors.number = 'Card number is required';
  else if (!/^\d+$/.test(n)) errors.number = 'Card number can only contain digits';
  else if (!brand) errors.number = 'We accept Visa, Mastercard and American Express';
  else if (brand === 'amex' ? n.length !== 15 : n.length !== 16) {
    errors.number = brand === 'amex' ? 'American Express numbers have 15 digits' : 'Card numbers have 16 digits';
  } else if (!luhnValid(n)) errors.number = 'That card number is not valid. Check for a typing mistake.';

  const m = Number(card.expMonth);
  const y = normYear(card.expYear);
  if (!Number.isInteger(m) || m < 1 || m > 12) errors.expMonth = 'Enter a valid month (01-12)';
  else if (!Number.isInteger(y) || y < 2000 || y > 2100) errors.expYear = 'Enter a valid year';
  else {
    // a card is valid through the last day of its expiry month
    const endOfMonth = new Date(Date.UTC(y, m, 1)).getTime();
    if (endOfMonth <= now.getTime()) errors.expYear = 'This card has expired';
  }

  const cvv = String(card.cvv ?? '');
  const want = brand === 'amex' ? 4 : 3;
  if (!cvv) errors.cvv = 'Security code is required';
  else if (!new RegExp(`^\\d{${want}}$`).test(cvv)) errors.cvv = `Security code must be ${want} digits`;
  return errors;
}

export const cvvValid = (cvv, brand) => new RegExp(`^\\d{${brand === 'amex' ? 4 : 3}}$`).test(String(cvv ?? ''));

/** Zod schema for a new card in a request. Issues are attached to the individual card fields. */
export const cardInputSchema = z
  .object({
    number: z.string({ error: 'Card number is required' }).min(1, 'Card number is required'),
    expMonth: z.coerce.number({ error: 'Enter a valid month (01-12)' }),
    expYear: z.coerce.number({ error: 'Enter a valid year' }),
    cvv: z.string({ error: 'Security code is required' }).min(1, 'Security code is required'),
    holder: z.string({ error: 'Name on card is required' }).trim().min(2, 'Name on card is required').max(80),
  })
  .superRefine((c, ctx) => {
    for (const [field, message] of Object.entries(validateCard(c))) ctx.addIssue({ code: 'custom', path: [field], message });
  });

/** Simulated bank outcome from a card number. */
export function simOutcome(number) {
  const n = digits(number);
  if (n === '4000000000000002') return 'declined';
  if (n === '4000000000009995') return 'insufficient';
  if (n === '4000000000009979') return 'lost';
  return 'approve';
}

const DECLINE_TEXT = {
  declined: 'Your card was declined by the bank. Please try another card or payment method.',
  insufficient: 'Your card has insufficient funds. Please try another card or payment method.',
  lost: 'This card cannot be used. Please try another card or contact your bank.',
};

/** Stand-in for the bank's "VISA Check" service. */
export async function visaCheck({ outcome, amount }) {
  await sleep(120);
  if (outcome !== 'approve') return { approved: false, reason: DECLINE_TEXT[outcome] || DECLINE_TEXT.declined };
  if (amount <= 0) return { approved: false, reason: 'Invalid amount' };
  return { approved: true, ref: 'VC-' + crypto.randomBytes(5).toString('hex').toUpperCase() };
}

const declined = (reason) => new HttpError(402, reason, 'payment_declined');

/**
 * Save a card for later (ID-14). Never stores the number or CVV.
 * `known` is used after a 3D Secure check, when only brand, last 4 digits and expiry are kept.
 */
export async function createSavedCard(db, userId, card, known = null) {
  const run = db ? db.query.bind(db) : query;
  const n = card ? digits(card.number) : null;
  const f = known || {
    brand: detectBrand(n),
    last4: n.slice(-4),
    expMonth: Number(card.expMonth),
    expYear: normYear(card.expYear),
    holder: card.holder,
    outcome: simOutcome(n),
  };
  const dup = await run('SELECT * FROM saved_cards WHERE user_id=$1 AND last4=$2 AND exp_month=$3 AND exp_year=$4 AND brand=$5', [
    userId, f.last4, f.expMonth, f.expYear, f.brand,
  ]);
  if (dup.rowCount) return dup.rows[0];
  const { rows } = await run(
    `INSERT INTO saved_cards (user_id, brand, last4, exp_month, exp_year, holder_name, gateway_token, sim_outcome)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [userId, f.brand, f.last4, f.expMonth, f.expYear, f.holder, 'tok_' + crypto.randomBytes(10).toString('hex'), f.outcome],
  );
  return rows[0];
}

export const serializeCard = (c) => ({
  id: c.id,
  brand: c.brand,
  brandLabel: BRAND_LABEL[c.brand],
  last4: c.last4,
  expMonth: c.exp_month,
  expYear: c.exp_year,
  holder: c.holder_name,
  expired: new Date(Date.UTC(c.exp_year, c.exp_month, 1)).getTime() <= Date.now(),
});

/** Audit trail for a declined attempt (written after the booking transaction rolled back). */
export async function recordDeclined({ userId, amount, method, card, reason }) {
  await query(
    `INSERT INTO payments (booking_id, user_id, kind, method, amount, status, card_brand, card_last4, decline_reason)
     VALUES (NULL,$1,'charge',$2,$3,'declined',$4,$5,$6)`,
    [userId, method, amount, card?.brand || null, card?.last4 || null, reason],
  );
}

/** Refund (simulated): used by cancellation (US8.1) and amendments (US8.2). */
export async function refundPayment(db, { bookingId, userId, amount, note }) {
  if (amount <= 0) return null;
  const { rows: last } = await db.query(
    `SELECT * FROM payments WHERE booking_id=$1 AND kind='charge' AND status='approved' ORDER BY created_at DESC LIMIT 1`,
    [bookingId],
  );
  const orig = last[0];
  if (!orig) return null;
  const { rows } = await db.query(
    `INSERT INTO payments (booking_id, user_id, kind, method, amount, status, card_brand, card_last4, paypal_payer, gateway_ref, note, bank_name)
     VALUES ($1,$2,'refund',$3,$4,'approved',$5,$6,$7,$8,$9,$10) RETURNING *`,
    [bookingId, userId, orig.method, amount, orig.card_brand, orig.card_last4, orig.paypal_payer,
      'RF-' + crypto.randomBytes(5).toString('hex').toUpperCase(), note || null, orig.bank_name],
  );
  return rows[0];
}

export const serializePayment = (p) => ({
  id: p.id,
  kind: p.kind,
  method: p.method,
  amount: p.amount,
  status: p.status,
  cardBrand: p.card_brand,
  cardBrandLabel: p.card_brand ? BRAND_LABEL[p.card_brand] : null,
  cardLast4: p.card_last4,
  paypalPayer: p.paypal_payer,
  bankName: p.bank_name,
  scaVerified: p.sca_verified,
  declineReason: p.decline_reason,
  reference: p.gateway_ref,
  note: p.note,
  createdAt: p.created_at,
});

/** Human text used in emails and receipts. */
export const describeMethod = (p) =>
  ({
    card: `${BRAND_LABEL[p.card_brand]} ending ${p.card_last4}`,
    paypal: 'PayPal',
    bank: `Pay by bank${p.bank_name ? ` (${p.bank_name})` : ''}`,
    cash: 'Cash',
    invoice: 'Company account (monthly invoice)',
  })[p.method] || p.method;
