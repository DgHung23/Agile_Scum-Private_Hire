import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query } from '../db.js';
import { customerOnly } from '../middleware/auth.js';
import { body, wrap } from '../middleware/validate.js';
import { notFound } from '../errors.js';
import { cardInputSchema, createSavedCard, serializeCard } from '../services/payments.js';
import { emailSchema } from '../schemas.js';

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

/* ---------- simulated PayPal (US5.4) ---------- */

router.post(
  '/paypal/start',
  body(z.object({ amount: z.coerce.number().positive('Amount must be more than zero').max(5000) })),
  wrap(async (req, res) => {
    const token = 'PPTOK-' + crypto.randomBytes(8).toString('hex');
    await query('INSERT INTO paypal_sessions (token, user_id, amount) VALUES ($1,$2,$3)', [token, req.user.id, req.body.amount]);
    res.status(201).json({ token, amount: req.body.amount });
  }),
);

async function ownSession(req) {
  const { rows } = await query('SELECT * FROM paypal_sessions WHERE token=$1 AND user_id=$2', [req.params.token, req.user.id]);
  if (!rows[0]) throw notFound('PayPal session not found');
  return rows[0];
}

router.get(
  '/paypal/:token',
  wrap(async (req, res) => {
    const s = await ownSession(req);
    res.json({ token: s.token, amount: s.amount, status: s.status });
  }),
);

router.post(
  '/paypal/:token/approve',
  body(z.object({ email: emailSchema })),
  wrap(async (req, res) => {
    const s = await ownSession(req);
    if (s.status === 'used') throw notFound('This PayPal payment has already been used');
    await query("UPDATE paypal_sessions SET status='approved', payer_email=$2 WHERE token=$1", [s.token, req.body.email]);
    res.json({ token: s.token, status: 'approved' });
  }),
);

router.post(
  '/paypal/:token/cancel',
  wrap(async (req, res) => {
    const s = await ownSession(req);
    if (s.status !== 'used') await query("UPDATE paypal_sessions SET status='cancelled' WHERE token=$1", [s.token]);
    res.json({ token: s.token, status: 'cancelled' });
  }),
);
