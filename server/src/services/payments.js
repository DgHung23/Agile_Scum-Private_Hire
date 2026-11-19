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

export const paymentSchema = z
  .object({
    method: z.enum(['card', 'paypal'], { error: 'Choose how you would like to pay' }),
    card: cardInputSchema.optional(),
    savedCardId: z.string().uuid().optional(),
    cvv: z.string().optional(),
    saveCard: z.boolean().optional(),
    token: z.string().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.method === 'card' && !p.card && !p.savedCardId) {
      ctx.addIssue({ code: 'custom', path: ['card', 'number'], message: 'Enter your card details or choose a saved card' });
    }
    if (p.method === 'paypal' && !p.token) {
      ctx.addIssue({ code: 'custom', path: ['token'], message: 'Approve the payment in PayPal first' });
    }
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

/** Save a card for later (US1.4). Never stores the number or CVV. */
export async function createSavedCard(db, userId, card) {
  const run = db ? db.query.bind(db) : query;
  const n = digits(card.number);
  const dup = await run('SELECT * FROM saved_cards WHERE user_id=$1 AND last4=$2 AND exp_month=$3 AND exp_year=$4 AND brand=$5', [
    userId, n.slice(-4), Number(card.expMonth), normYear(card.expYear), detectBrand(n),
  ]);
  if (dup.rowCount) return dup.rows[0];
  const { rows } = await run(
    `INSERT INTO saved_cards (user_id, brand, last4, exp_month, exp_year, holder_name, gateway_token, sim_outcome)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [userId, detectBrand(n), n.slice(-4), Number(card.expMonth), normYear(card.expYear), card.holder, 'tok_' + crypto.randomBytes(10).toString('hex'), simOutcome(n)],
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

/**
 * Take a payment for a booking inside the booking transaction.
 * Throws HttpError 402 when declined so the whole booking rolls back (US5.3 criterion 3).
 * The caller records declined attempts afterwards with recordDeclined().
 */
export async function takePayment(db, { userId, bookingId, amount, payment }) {
  if (payment.method === 'cash') {
    const { rows } = await db.query(
      `INSERT INTO payments (booking_id, user_id, kind, method, amount, status, note) VALUES ($1,$2,'charge','cash',$3,'approved','Paid in person') RETURNING *`,
      [bookingId, userId, amount],
    );
    return rows[0];
  }

  if (payment.method === 'paypal') {
    const { rows } = await db.query('SELECT * FROM paypal_sessions WHERE token=$1 FOR UPDATE', [payment.token]);
    const s = rows[0];
    if (!s || s.user_id !== userId) throw declined('PayPal payment was not found. Please start again.');
    if (s.status === 'cancelled') throw declined('You cancelled the PayPal payment.');
    if (s.status !== 'approved') throw declined('Approve the payment in PayPal before confirming.');
    if (Math.abs(Number(s.amount) - amount) > 0.005) {
      throw declined(`The price changed to GBP ${amount.toFixed(2)} since you approved the PayPal payment. Please approve it again.`);
    }
    await db.query("UPDATE paypal_sessions SET status='used' WHERE token=$1", [payment.token]);
    const ref = 'PP-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    const ins = await db.query(
      `INSERT INTO payments (booking_id, user_id, kind, method, amount, status, paypal_payer, gateway_ref)
       VALUES ($1,$2,'charge','paypal',$3,'approved',$4,$5) RETURNING *`,
      [bookingId, userId, amount, s.payer_email, ref],
    );
    return ins.rows[0];
  }

  // card
  let brand;
  let last4;
  let outcome;
  if (payment.savedCardId) {
    const { rows } = await db.query('SELECT * FROM saved_cards WHERE id=$1 AND user_id=$2', [payment.savedCardId, userId]);
    const c = rows[0];
    if (!c) throw badRequest('That saved card was not found', { 'payment.savedCardId': 'That saved card was not found' });
    if (serializeCard(c).expired) throw declined('This saved card has expired. Please use a different card.');
    if (!cvvValid(payment.cvv, c.brand)) {
      throw badRequest('Enter the security code for this card', {
        'payment.cvv': `Security code must be ${c.brand === 'amex' ? 4 : 3} digits`,
      });
    }
    ({ brand, last4, sim_outcome: outcome } = c);
  } else {
    const n = digits(payment.card.number);
    brand = detectBrand(n);
    last4 = n.slice(-4);
    outcome = simOutcome(n);
  }
  const check = await visaCheck({ outcome, amount });
  if (!check.approved) {
    const e = declined(check.reason);
    e.card = { brand, last4 };
    throw e;
  }
  const { rows } = await db.query(
    `INSERT INTO payments (booking_id, user_id, kind, method, amount, status, card_brand, card_last4, gateway_ref)
     VALUES ($1,$2,'charge','card',$3,'approved',$4,$5,$6) RETURNING *`,
    [bookingId, userId, amount, brand, last4, check.ref],
  );
  return rows[0];
}

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
    `INSERT INTO payments (booking_id, user_id, kind, method, amount, status, card_brand, card_last4, paypal_payer, gateway_ref, note)
     VALUES ($1,$2,'refund',$3,$4,'approved',$5,$6,$7,$8,$9) RETURNING *`,
    [bookingId, userId, orig.method, amount, orig.card_brand, orig.card_last4, orig.paypal_payer,
      'RF-' + crypto.randomBytes(5).toString('hex').toUpperCase(), note || null],
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
  reference: p.gateway_ref,
  note: p.note,
  createdAt: p.created_at,
});

/** Human text used in emails and receipts. */
export const describeMethod = (p) =>
  p.method === 'card' ? `${BRAND_LABEL[p.card_brand]} ending ${p.card_last4}` : p.method === 'paypal' ? 'PayPal' : 'Cash (paid in person)';
