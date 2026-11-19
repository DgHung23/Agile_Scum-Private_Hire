import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { customerOnly, staffOnly } from '../middleware/auth.js';
import { body, queryOf, wrap } from '../middleware/validate.js';
import { notFound } from '../errors.js';
import { emailSchema } from '../schemas.js';
import { audit } from '../services/audit.js';
import { loadReceiptDoc, renderPdf, sendReceipt, serializeReceiptDoc } from '../services/receipts.js';
import { requireVerified } from './callcentre.js';

/** Receipts (FR-6.1 to FR-6.10; ID-59, N37, N38, N39). */
export const router = Router(); // /receipts (customer)
export const staffRouter = Router(); // /staff (call centre)

const historyQuery = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  q: z.string().trim().max(30).optional(),
});

async function history(customerId, q) {
  const args = [customerId];
  const where = ['r.customer_id = $1'];
  if (q.from) {
    args.push(q.from);
    where.push(`r.created_at >= ($${args.length}::date AT TIME ZONE 'Europe/London')`);
  }
  if (q.to) {
    args.push(q.to);
    where.push(`r.created_at < (($${args.length}::date + 1) AT TIME ZONE 'Europe/London')`);
  }
  if (q.q) {
    args.push(`%${q.q.replace(/[%_]/g, '')}%`);
    where.push(`(b.ref ILIKE $${args.length} OR r.number ILIKE $${args.length})`);
  }
  const { rows } = await query(
    `SELECT r.*, b.ref, b.pickup, b.destination, b.pickup_at, b.status AS booking_status, rel.number AS related_number,
            (SELECT count(*)::int FROM receipt_sends s WHERE s.receipt_id = r.id) AS sends,
            (SELECT max(s.created_at) FROM receipt_sends s WHERE s.receipt_id = r.id) AS last_sent_at,
            EXISTS (SELECT 1 FROM receipts c WHERE c.related_receipt_id = r.id) AS has_credit_note
       FROM receipts r JOIN bookings b ON b.id = r.booking_id
       LEFT JOIN receipts rel ON rel.id = r.related_receipt_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.created_at DESC LIMIT 300`,
    args,
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    kind: r.kind,
    amount: Number(r.amount),
    createdAt: r.created_at,
    bookingId: r.booking_id,
    ref: r.ref,
    journey: `${r.pickup} to ${r.destination}`,
    pickupAt: r.pickup_at,
    status: r.kind === 'credit_note' ? 'Credit note' : r.has_credit_note ? 'Refunded' : 'Paid',
    relatedNumber: r.related_number,
    sends: r.sends,
    lastSentAt: r.last_sent_at,
  }));
}

/** N39: the customer's receipt history, newest first, with date filter and reference search. */
router.get(
  '/',
  ...customerOnly,
  queryOf(historyQuery),
  wrap(async (req, res) => res.json({ receipts: await history(req.user.id, req.query) })),
);

async function ownReceipt(req) {
  if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Receipt not found');
  const doc = await loadReceiptDoc(null, req.params.id);
  // FR-6.2: only the owner (or staff, below). Someone else's receipt looks like a missing one.
  if (!doc || doc.r.customer_id !== req.user.id) throw notFound('Receipt not found');
  return doc;
}

router.get(
  '/:id',
  ...customerOnly,
  wrap(async (req, res) => res.json({ receipt: serializeReceiptDoc(await ownReceipt(req)) })),
);

/** N37: Save as PDF - made on demand and downloaded as PrivateHire-receipt-<reference>.pdf. */
async function sendPdf(res, doc) {
  const x = serializeReceiptDoc(doc);
  const pdf = await renderPdf(x);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${x.kind === 'credit_note' ? x.pdfName.replace('receipt', 'credit-note') : x.pdfName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(pdf);
}

router.get(
  '/:id/pdf',
  ...customerOnly,
  wrap(async (req, res) => sendPdf(res, await ownReceipt(req))),
);

/** N38: send the receipt (PDF attached) to my own address or another one. */
router.post(
  '/:id/send',
  ...customerOnly,
  body(z.object({ to: emailSchema.optional() })),
  wrap(async (req, res) => {
    const doc = await ownReceipt(req);
    const to = req.body.to || req.user.email;
    const n = await tx((db) => sendReceipt(db, { receiptId: doc.r.id, to, sentBy: req.user.id }));
    res.status(202).json({ ok: true, to, notificationId: n.id, message: `We are sending the receipt to ${to}.` });
  }),
);

/* ---------- staff: a verified caller's receipts (FR-6.10); every view is audited ---------- */

staffRouter.get(
  '/customers/:id/receipts',
  ...staffOnly,
  queryOf(historyQuery),
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Customer not found');
    await requireVerified(req, req.params.id);
    await audit(null, req, 'receipt.history.view', 'user', req.params.id);
    res.json({ receipts: await history(req.params.id, req.query) });
  }),
);

async function staffReceipt(req) {
  if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Receipt not found');
  const doc = await loadReceiptDoc(null, req.params.id);
  if (!doc) throw notFound('Receipt not found');
  await requireVerified(req, doc.r.customer_id);
  return doc;
}

staffRouter.get(
  '/receipts/:id',
  ...staffOnly,
  wrap(async (req, res) => {
    const doc = await staffReceipt(req);
    await audit(null, req, 'receipt.view', 'receipt', doc.r.id, { number: doc.r.number });
    res.json({ receipt: serializeReceiptDoc(doc) });
  }),
);

staffRouter.get(
  '/receipts/:id/pdf',
  ...staffOnly,
  wrap(async (req, res) => {
    const doc = await staffReceipt(req);
    await audit(null, req, 'receipt.pdf', 'receipt', doc.r.id, { number: doc.r.number });
    await sendPdf(res, doc);
  }),
);

staffRouter.post(
  '/receipts/:id/send',
  ...staffOnly,
  body(z.object({ to: emailSchema.optional() })),
  wrap(async (req, res) => {
    const doc = await staffReceipt(req);
    const to = req.body.to || doc.customer.email;
    await tx(async (db) => {
      await sendReceipt(db, { receiptId: doc.r.id, to, sentBy: req.user.id });
      await audit(db, req, 'receipt.send', 'receipt', doc.r.id, { to });
    });
    res.status(202).json({ ok: true, to });
  }),
);

export async function latestReceiptId(bookingId) {
  const { rows } = await query("SELECT id FROM receipts WHERE booking_id=$1 AND kind='receipt' ORDER BY created_at LIMIT 1", [bookingId]);
  return rows[0]?.id || null;
}
