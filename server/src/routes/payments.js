import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { customerOnly } from '../middleware/auth.js';
import { body, wrap } from '../middleware/validate.js';
import { badRequest, notFound } from '../errors.js';
import { cardInputSchema, createSavedCard, serializeCard } from '../services/payments.js';
import { emailSchema } from '../schemas.js';
import { BANKS } from '../services/checkout.js';

export const router = Router();
router.use(...customerOnly);

/* ---------- saved cards (US1.4) ---------- */

router.get(
  '/cards',
  wrap(async (req, res) => {
    const { rows } = await query('SELECT * FROM saved_cards WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
    res.json({ cards: rows.map(serializeCard) });
  }),
);

// The CVV is validated but never stored
router.post(
  '/cards',
  body(cardInputSchema),
  wrap(async (req, res) => {
    const c = await createSavedCard(null, req.user.id, req.body);
    res.status(201).json({ card: serializeCard(c) });
  }),
);

router.delete(
  '/cards/:id',
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Card not found');
    const r = await query('DELETE FROM saved_cards WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!r.rowCount) throw notFound('Card not found');
    res.json({ ok: true });
  }),
);

/* ---------- simulated PayPal (ID-55) and pay by bank (ID-57) ---------- */
// The booking API creates the session (POST /bookings with method paypal or bank). These endpoints are what the
// simulated provider page uses: read the amount, approve or cancel. The customer then returns to the booking.

async function ownSession(req) {
  const { rows } = await query('SELECT * FROM redirect_sessions WHERE token=$1 AND user_id=$2', [req.params.token, req.user.id]);
  if (!rows[0]) throw notFound('Payment session not found');
  return rows[0];
}

router.get(
  '/redirect/:token',
  wrap(async (req, res) => {
    const s = await ownSession(req);
    const b = (await query('SELECT id, ref FROM bookings WHERE group_id=$1 ORDER BY pickup_at LIMIT 1', [s.group_id])).rows[0];
    res.json({ token: s.token, provider: s.provider, amount: s.amount, status: s.status, bookingId: b?.id, ref: b?.ref, banks: BANKS });
  }),
);

router.post(
  '/redirect/:token/approve',
  body(z.object({ email: emailSchema.optional(), bankName: z.enum(BANKS).optional() })),
  wrap(async (req, res) => {
    const s = await ownSession(req);
    if (s.status === 'used') throw notFound('This payment has already been used');
    if (s.provider === 'paypal' && !req.body.email) throw badRequest('Enter your PayPal email', { email: 'Enter your PayPal email' });
    if (s.provider === 'bank' && !req.body.bankName) throw badRequest('Choose your bank', { bankName: 'Choose your bank' });
    await query("UPDATE redirect_sessions SET status='approved', payer_email=$2, bank_name=$3 WHERE token=$1", [s.token, req.body.email || null, req.body.bankName || null]);
    res.json({ token: s.token, status: 'approved' });
  }),
);

router.post(
  '/redirect/:token/cancel',
  wrap(async (req, res) => {
    const s = await ownSession(req);
    if (s.status !== 'used') await query("UPDATE redirect_sessions SET status='cancelled' WHERE token=$1", [s.token]);
    res.json({ token: s.token, status: 'cancelled' });
  }),
);
