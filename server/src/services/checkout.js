import crypto from 'node:crypto';
import { z } from 'zod';
import { HttpError, badRequest } from '../errors.js';
import { bookingConfirmationEmail, loadBookingRow } from './booking.js';
import { sendEmail } from './notify.js';
import {
  cardInputSchema,
  createSavedCard,
  cvvValid,
  describeMethod,
  detectBrand,
  serializeCard,
  simOutcome,
  visaCheck,
} from './payments.js';

/*
 * Online checkout (report Figure 26, sequence diagram; stories ID-53 to ID-57).
 *  1. The booking is created as Pending payment and holds its cab for 15 minutes.
 *  2. Card: a 3D Secure (Strong Customer Authentication) challenge is created. The customer confirms it on the
 *     simulated bank screen with the one-time code 123456. Then the bank (VISA Check, simulated) authorises it.
 *     A declined card cannot confirm the booking; the customer retries with the journey details kept (ID-54).
 *  3. PayPal (ID-55) and pay-by-bank (ID-57): the customer is sent to the provider (simulated) and back.
 *  4. Cash to the driver (ID-56): confirmed at once, paid at the end of the journey.
 * The card number is never stored; only brand, last 4 digits and expiry.
 */

export const SCA_TEST_CODE = '123456';
const digits = (s) => String(s ?? '').replace(/[\s-]/g, '');
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export const BANKS = ['Barclays', 'HSBC UK', 'Lloyds', 'NatWest', 'Monzo', 'Santander UK', 'Nationwide'];

export const paymentSchema = z
  .object({
    method: z.enum(['card', 'paypal', 'bank', 'cash'], { error: 'Choose how you would like to pay' }),
    card: cardInputSchema.optional(),
    savedCardId: z.string().uuid().optional(),
    cvv: z.string().optional(),
    saveCard: z.boolean().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.method === 'card' && !p.card && !p.savedCardId) {
      ctx.addIssue({ code: 'custom', path: ['card', 'number'], message: 'Enter your card details or choose a saved card' });
    }
  });

const groupTotal = (rows) => r2(rows.reduce((a, b) => a + Number(b.total), 0));

/** Mark the whole group paid and confirmed, write one payment row per booking, and send the confirmations. */
async function confirmGroup(db, rows, customer, paymentFields) {
  const payments = [];
  for (const b of rows) {
    const { rows: pr } = await db.query(
      `INSERT INTO payments (booking_id, user_id, kind, method, amount, status, card_brand, card_last4, paypal_payer,
                             gateway_ref, sca_verified, bank_name, note)
       VALUES ($1,$2,'charge',$3,$4,'approved',$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        b.id, customer.id, paymentFields.method, b.total, paymentFields.brand || null, paymentFields.last4 || null,
        paymentFields.payer || null, paymentFields.ref, !!paymentFields.sca, paymentFields.bankName || null, paymentFields.note || null,
      ],
    );
    payments.push(pr[0]);
    await db.query(
      "UPDATE bookings SET status='confirmed', payment_status='paid', hold_expires_at=NULL, updated_at=now() WHERE id=$1",
      [b.id],
    );
  }
  const done = await sendConfirmations(db, rows, customer, describeMethod(payments[0]));
  return { rows: done, payments };
}

/** ID-44: the booking is saved first, then the confirmation is sent. */
async function sendConfirmations(db, rows, customer, paidWith) {
  const out = [];
  for (const b of rows) {
    const row = await loadBookingRow(db, b.id);
    const mail = bookingConfirmationEmail(row, customer.full_name, paidWith);
    await sendEmail({ userId: customer.id, to: customer.email, kind: 'booking_confirmed', bookingId: row.id, ...mail }, db);
    out.push(row);
  }
  return out;
}

/**
 * Start paying for a group of Pending payment bookings.
 * Returns { done: true, rows, payments } when finished, or { done: false, nextAction } when the customer must act.
 */
export async function beginPayment(db, { rows, customer, payment }) {
  if (!rows.length || rows.some((b) => b.status !== 'pending_payment')) {
    throw new HttpError(409, 'This booking is not waiting for payment.', 'not_pending');
  }
  if (rows.some((b) => b.hold_expires_at && new Date(b.hold_expires_at).getTime() < Date.now())) {
    throw new HttpError(409, 'The time to pay for this booking has run out and the cab was released. Please book again.', 'hold_expired');
  }
  const amount = groupTotal(rows);
  const groupId = rows[0].group_id;

  if (payment.method === 'cash') {
    // ID-56: pay the driver in cash at the end of the journey.
    for (const b of rows) {
      await db.query(
        "UPDATE bookings SET status='confirmed', payment_status='due_cash', hold_expires_at=NULL, updated_at=now() WHERE id=$1",
        [b.id],
      );
    }
    const done = await sendConfirmations(db, rows, customer, 'Cash to the driver at the end of the journey');
    return { done: true, rows: done, payments: [] };
  }

  if (payment.method === 'paypal' || payment.method === 'bank') {
    const token = (payment.method === 'paypal' ? 'PPTOK-' : 'OBTOK-') + crypto.randomBytes(8).toString('hex');
    await db.query(
      'INSERT INTO redirect_sessions (token, user_id, amount, provider, group_id) VALUES ($1,$2,$3,$4,$5)',
      [token, customer.id, amount, payment.method, groupId],
    );
    return { done: false, nextAction: { type: 'redirect', provider: payment.method, token, amount, bookingId: rows[0].id } };
  }

  // Card: create a 3D Secure challenge.
  let card;
  if (payment.savedCardId) {
    const { rows: cs } = await db.query('SELECT * FROM saved_cards WHERE id=$1 AND user_id=$2', [payment.savedCardId, customer.id]);
    const c = cs[0];
    if (!c) throw badRequest('That saved card was not found', { 'payment.savedCardId': 'That saved card was not found' });
    if (serializeCard(c).expired) throw new HttpError(402, 'This saved card has expired. Please use a different card.', 'payment_declined');
    if (!cvvValid(payment.cvv, c.brand)) {
      throw badRequest('Enter the security code for this card', { 'payment.cvv': `Security code must be ${c.brand === 'amex' ? 4 : 3} digits` });
    }
    card = { brand: c.brand, last4: c.last4, exp_month: c.exp_month, exp_year: c.exp_year, holder: c.holder_name, outcome: c.sim_outcome, savedId: c.id };
  } else {
    const n = digits(payment.card.number);
    const y = Number(payment.card.expYear);
    card = {
      brand: detectBrand(n),
      last4: n.slice(-4),
      exp_month: Number(payment.card.expMonth),
      exp_year: y < 100 ? 2000 + y : y,
      holder: payment.card.holder,
      outcome: simOutcome(n),
      savedId: null,
    };
  }
  const { rows: ch } = await db.query(
    `INSERT INTO sca_challenges (group_id, user_id, amount, brand, last4, exp_month, exp_year, holder_name, sim_outcome,
                                 saved_card_id, save_card)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [groupId, customer.id, amount, card.brand, card.last4, card.exp_month, card.exp_year, card.holder, card.outcome, card.savedId, !!payment.saveCard && !card.savedId],
  );
  return {
    done: false,
    nextAction: { type: '3ds', challengeId: ch[0].id, amount, brand: card.brand, last4: card.last4, bookingId: rows[0].id },
  };
}

/**
 * ID-53: finish the 3D Secure challenge, then ask the bank.
 * A wrong code or a declined card leaves the booking Pending payment so the customer can try again (ID-54).
 * Returns { ok, rows, payments } or { ok: false, error } - the caller commits either way so the attempt is kept.
 */
export async function complete3ds(db, { rows, customer, challengeId, code }) {
  const { rows: chs } = await db.query('SELECT * FROM sca_challenges WHERE id=$1 AND user_id=$2 FOR UPDATE', [challengeId, customer.id]);
  const ch = chs[0];
  if (!ch || ch.group_id !== rows[0]?.group_id) throw new HttpError(404, 'Payment check not found', 'not_found');
  if (ch.status !== 'pending') throw new HttpError(409, 'This payment check has already been used. Please try paying again.', 'sca_used');
  if (new Date(ch.expires_at).getTime() < Date.now()) {
    await db.query("UPDATE sca_challenges SET status='expired' WHERE id=$1", [ch.id]);
    throw new HttpError(409, 'The bank check timed out. Please try paying again.', 'sca_expired');
  }
  if (rows.some((b) => b.status !== 'pending_payment')) throw new HttpError(409, 'This booking is not waiting for payment.', 'not_pending');

  if (String(code || '').trim() !== SCA_TEST_CODE) {
    const attempts = ch.attempts + 1;
    await db.query("UPDATE sca_challenges SET attempts=$2, status=CASE WHEN $2 >= 3 THEN 'failed' ELSE status END WHERE id=$1", [ch.id, attempts]);
    await recordAttempt(db, rows[0], customer, ch, 'Bank security check (3D Secure) failed');
    return {
      ok: false,
      error: new HttpError(
        402,
        attempts >= 3 ? 'The bank could not confirm it was you. Please try another card.' : 'That code is not right. Check the code from your bank and try again.',
        attempts >= 3 ? 'sca_failed' : 'sca_wrong_code',
      ),
    };
  }

  const check = await visaCheck({ outcome: ch.sim_outcome, amount: Number(ch.amount) });
  if (!check.approved) {
    await db.query("UPDATE sca_challenges SET status='declined' WHERE id=$1", [ch.id]);
    await recordAttempt(db, rows[0], customer, ch, check.reason);
    return { ok: false, error: new HttpError(402, check.reason, 'payment_declined') };
  }
  await db.query("UPDATE sca_challenges SET status='passed' WHERE id=$1", [ch.id]);
  if (ch.save_card) {
    await createSavedCard(db, customer.id, null, {
      brand: ch.brand, last4: ch.last4, expMonth: ch.exp_month, expYear: ch.exp_year, holder: ch.holder_name, outcome: ch.sim_outcome,
    });
  }
  const out = await confirmGroup(db, rows, customer, { method: 'card', brand: ch.brand, last4: ch.last4, ref: check.ref, sca: true });
  return { ok: true, ...out };
}

/** PayPal / pay-by-bank: the customer came back from the provider (simulated). */
export async function completeRedirect(db, { rows, customer, token }) {
  const { rows: ss } = await db.query('SELECT * FROM redirect_sessions WHERE token=$1 AND user_id=$2 FOR UPDATE', [token, customer.id]);
  const s = ss[0];
  if (!s || s.group_id !== rows[0]?.group_id) throw new HttpError(404, 'Payment not found. Please start again.', 'not_found');
  const name = s.provider === 'paypal' ? 'PayPal' : 'your bank';
  if (s.status === 'cancelled') throw new HttpError(402, `You cancelled the payment in ${name}.`, 'payment_cancelled');
  if (s.status === 'used') throw new HttpError(409, 'This payment has already been used.', 'payment_used');
  if (s.status !== 'approved') throw new HttpError(402, `Approve the payment in ${name} first.`, 'payment_pending');
  if (rows.some((b) => b.status !== 'pending_payment')) throw new HttpError(409, 'This booking is not waiting for payment.', 'not_pending');
  if (Math.abs(Number(s.amount) - groupTotal(rows)) > 0.005) throw new HttpError(409, 'The amount changed. Please pay again.', 'amount_changed');
  await db.query("UPDATE redirect_sessions SET status='used' WHERE token=$1", [token]);
  const ref = (s.provider === 'paypal' ? 'PP-' : 'OB-') + crypto.randomBytes(5).toString('hex').toUpperCase();
  return confirmGroup(db, rows, customer, { method: s.provider, payer: s.payer_email, bankName: s.bank_name, ref });
}

/** Audit trail of a failed attempt on a Pending payment booking. */
async function recordAttempt(db, booking, customer, ch, reason) {
  await db.query(
    `INSERT INTO payments (booking_id, user_id, kind, method, amount, status, card_brand, card_last4, decline_reason)
     VALUES ($1,$2,'charge','card',$3,'declined',$4,$5,$6)`,
    [booking.id, customer.id, ch.amount, ch.brand, ch.last4, reason],
  );
}

/** The customer gives up on paying (or the hold ran out): the cab and the coupon are released. */
export async function abandonGroup(db, rows) {
  for (const b of rows) {
    if (b.status !== 'pending_payment') continue;
    await db.query("UPDATE bookings SET status='abandoned', hold_expires_at=NULL, updated_at=now() WHERE id=$1", [b.id]);
    await db.query('DELETE FROM coupon_redemptions WHERE booking_id=$1', [b.id]);
  }
}

/*
 * ID-35, ID-36: staff record payment for a phone or walk-in booking. Card details read over the phone are a
 * "mail order / telephone order" payment, which is outside 3D Secure, so the bank is asked straight away.
 * method: 'card' (keyed by staff), 'cash' (paid at the desk), 'driver' (cash to the driver at the end).
 */
export const staffPaymentSchema = z
  .discriminatedUnion('method', [
    z.object({ method: z.literal('card'), card: cardInputSchema }),
    z.object({ method: z.literal('cash') }),
    z.object({ method: z.literal('driver') }),
  ])
  .optional();

export async function payStaff(db, { rows, customer, payment }) {
  if (!payment || payment.method === 'driver') {
    for (const b of rows) await db.query("UPDATE bookings SET payment_status='due_cash' WHERE id=$1", [b.id]);
    const done = await sendConfirmations(db, rows, customer, 'Cash to the driver at the end of the journey');
    return { rows: done, payments: [] };
  }
  if (payment.method === 'cash') {
    return confirmGroup(db, rows, customer, { method: 'cash', ref: 'CA-' + crypto.randomBytes(5).toString('hex').toUpperCase(), note: 'Paid in person' });
  }
  const n = digits(payment.card.number);
  const check = await visaCheck({ outcome: simOutcome(n), amount: groupTotal(rows) });
  if (!check.approved) {
    const e = new HttpError(402, check.reason, 'payment_declined');
    e.card = { brand: detectBrand(n), last4: n.slice(-4) };
    throw e;
  }
  return confirmGroup(db, rows, customer, { method: 'card', brand: detectBrand(n), last4: n.slice(-4), ref: check.ref });
}
