import PDFDocument from 'pdfkit';
import { query } from '../db.js';
import { HttpError } from '../errors.js';
import { ACCESSIBILITY_LABEL, loadBookingRow, serializeBooking } from './booking.js';
import { sendEmail, setAttachmentBuilder } from './notify.js';
import { BRAND_LABEL, describeMethod, serializePayment } from './payments.js';

/*
 * Receipts (report FR-6.1 to FR-6.10; stories ID-59, N37, N38, N39).
 * - A receipt is created once, when a payment succeeds, and goes into the customer's receipt history.
 * - A refund creates a linked credit note; the original receipt never changes.
 * - Receipts are shown only to their owner or to staff (after caller verification; the view is audited).
 * - "Save as PDF" is generated on demand; "Send receipt" emails the PDF (3 sends per booking per hour).
 */
export const COMPANY = {
  name: 'Private Hire Cars',
  address: '1 Example Street, London, United Kingdom',
  phone: '020 7000 0000',
  email: 'bookings@privatehire.example',
  vatNo: 'GB 123 4567 89',
};
const VAT_RATE = 0.2;
const SEND_LIMIT_PER_HOUR = 3;
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const pdfName = (ref) => `PrivateHire-receipt-${ref}.pdf`;

/** Create the receipt (charge) or credit note (refund) for an approved payment. Safe to call twice. */
export async function receiptForPayment(db, payment) {
  if (!payment || payment.status !== 'approved' || !payment.booking_id) return null;
  const run = db ? db.query.bind(db) : query;
  const existing = await run('SELECT * FROM receipts WHERE payment_id=$1', [payment.id]);
  if (existing.rows[0]) return existing.rows[0];
  const { rows: b } = await run('SELECT ref, customer_id FROM bookings WHERE id=$1', [payment.booking_id]);
  const ref = b[0].ref.replace(/^PH-/, '');
  const credit = payment.kind === 'refund';
  const { rows: count } = await run('SELECT count(*)::int AS n FROM receipts WHERE booking_id=$1 AND kind=$2', [
    payment.booking_id, credit ? 'credit_note' : 'receipt',
  ]);
  const n = count[0].n + 1;
  const number = credit ? `CN-${ref}-${n}` : `RC-${ref}${n > 1 ? `-${n}` : ''}`;
  const related = credit
    ? (await run("SELECT id FROM receipts WHERE booking_id=$1 AND kind='receipt' ORDER BY created_at LIMIT 1", [payment.booking_id])).rows[0]?.id || null
    : null;
  const { rows } = await run(
    `INSERT INTO receipts (number, kind, booking_id, customer_id, payment_id, related_receipt_id, amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [number, credit ? 'credit_note' : 'receipt', payment.booking_id, b[0].customer_id, payment.id, related, payment.amount],
  );
  return rows[0];
}

/** Everything shown on a receipt page or PDF. */
export async function loadReceiptDoc(db, receiptId) {
  const run = db ? db.query.bind(db) : query;
  const { rows } = await run('SELECT * FROM receipts WHERE id=$1', [receiptId]);
  const r = rows[0];
  if (!r) return null;
  const booking = await loadBookingRow(db, r.booking_id);
  const customer = (await run('SELECT * FROM users WHERE id=$1', [r.customer_id])).rows[0];
  const payment = r.payment_id ? (await run('SELECT * FROM payments WHERE id=$1', [r.payment_id])).rows[0] : null;
  const related = (
    await run(
      `SELECT id, number, kind, amount, created_at FROM receipts
        WHERE booking_id=$1 AND id<>$2 ORDER BY created_at`,
      [r.booking_id, r.id],
    )
  ).rows;
  const sends = (
    await run(
      `SELECT s.*, n.status, n.attempts, n.last_error, u.full_name AS sent_by_name, u.role AS sent_by_role
         FROM receipt_sends s LEFT JOIN notifications n ON n.id = s.notification_id LEFT JOIN users u ON u.id = s.sent_by
        WHERE s.receipt_id=$1 ORDER BY s.created_at DESC`,
      [r.id],
    )
  ).rows;
  const company = booking.company_id ? (await run('SELECT name FROM companies WHERE id=$1', [booking.company_id]).catch(() => ({ rows: [] }))).rows[0] : null;
  return { r, booking, customer, payment, related, sends, company };
}

export function serializeReceiptDoc(doc) {
  const { r, booking, customer, payment, related, sends, company } = doc;
  const b = serializeBooking(booking);
  const amount = Number(r.amount);
  return {
    id: r.id,
    number: r.number,
    kind: r.kind,
    amount,
    vatIncluded: r2(amount - amount / (1 + VAT_RATE)),
    createdAt: r.created_at,
    pdfName: pdfName(booking.ref),
    company: COMPANY,
    customer: {
      name: customer.full_name,
      email: customer.email,
      address: [customer.address_line, customer.city, customer.postcode].filter(Boolean).join(', '),
    },
    businessAccount: company ? { name: company.name, costCentre: booking.cost_centre || null } : null,
    booking: {
      id: b.id, ref: b.ref, status: b.status, service: b.service.label, package: b.package?.label || null, pickup: b.pickup,
      destination: b.destination, pickupAt: b.pickupAt, passengers: b.passengers, size: b.size.label, hours: b.hours,
      channel: b.channel, extras: [
        ...(b.childSeatAges.length ? [`${b.childSeatAges.length} child seat(s)`] : []),
        ...b.accessibility.map((a) => ACCESSIBILITY_LABEL[a]),
      ],
    },
    price: b.price,
    payment: payment ? { ...serializePayment(payment), description: describeMethod(payment) } : null,
    refunded: b.paymentStatus === 'refunded' || related.some((x) => x.kind === 'credit_note'),
    related: related.map((x) => ({ id: x.id, number: x.number, kind: x.kind, amount: Number(x.amount), createdAt: x.created_at })),
    sends: sends.map((s) => ({
      id: s.id, to: s.to_addr, at: s.created_at, automatic: s.automatic, status: s.status || 'queued', attempts: s.attempts,
      error: s.last_error, by: s.sent_by_name ? `${s.sent_by_name}${s.sent_by_role !== 'customer' ? ' (staff)' : ''}` : 'Automatic',
    })),
  };
}

const gbp = (n) => `GBP ${Number(n).toFixed(2)}`;
const when = (d) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/London' }).format(new Date(d));

/** N37: a print-friendly, black-and-white PDF made on demand. */
export function renderPdf(x) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `${x.kind === 'credit_note' ? 'Credit note' : 'Receipt'} ${x.number}`, Author: COMPANY.name } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width - 100;
    const row = (label, value, opts = {}) => {
      const y = doc.y;
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 10).fillColor('#000');
      doc.text(label, 50, y, { width: W * 0.65 });
      const h = doc.y;
      doc.text(value, 50 + W * 0.65, y, { width: W * 0.35, align: 'right' });
      doc.y = Math.max(h, doc.y) + 3;
    };
    const rule = () => {
      doc.moveTo(50, doc.y + 2).lineTo(50 + W, doc.y + 2).lineWidth(0.6).strokeColor('#000').stroke();
      doc.y += 8;
    };

    doc.font('Helvetica-Bold').fontSize(20).text(COMPANY.name);
    doc.font('Helvetica').fontSize(9).text(`${COMPANY.address}  |  ${COMPANY.phone}  |  ${COMPANY.email}  |  VAT ${COMPANY.vatNo}`);
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(16).text(x.kind === 'credit_note' ? 'Credit note' : 'Receipt', 50, doc.y, { width: W });
    doc.moveDown(0.3);
    row(x.kind === 'credit_note' ? 'Credit note number' : 'Receipt number', x.number);
    row('Booking reference', x.booking.ref);
    row(x.kind === 'credit_note' ? 'Date refunded' : 'Date paid', when(x.createdAt));
    row('Customer', `${x.customer.name}, ${x.customer.email}`);
    if (x.businessAccount) row('Company account', `${x.businessAccount.name}${x.businessAccount.costCentre ? `, cost centre ${x.businessAccount.costCentre}` : ''}`);
    doc.moveDown(0.6);
    rule();
    doc.font('Helvetica-Bold').fontSize(11).text('Journey', 50, doc.y, { width: W });
    doc.moveDown(0.2);
    row('Service', x.booking.package ? `${x.booking.service} - ${x.booking.package}` : x.booking.service);
    row('From', x.booking.pickup);
    row('To', x.booking.destination);
    row('Pickup', when(x.booking.pickupAt));
    row('Passengers and cab', `${x.booking.passengers}, ${x.booking.size}`);
    for (const e of x.booking.extras) row('Extra', `${e} (no charge)`);
    doc.moveDown(0.4);
    rule();
    if (x.kind === 'receipt') {
      doc.font('Helvetica-Bold').fontSize(11).text('Price', 50, doc.y, { width: W });
      doc.moveDown(0.2);
      for (const l of x.price.lines || []) row(l.label, gbp(l.amount));
      if (x.price.discountOnline > 0) row('Online discount', `-${gbp(x.price.discountOnline)}`);
      if (x.price.discountOffer > 0) row(`Coupon ${x.price.offerCode || ''}`, `-${gbp(x.price.discountOffer)}`);
      row('Booking total', gbp(x.price.total), { bold: true });
      doc.moveDown(0.4);
      rule();
    }
    row(x.kind === 'credit_note' ? 'Amount refunded' : 'Amount paid', gbp(x.amount), { bold: true, size: 12 });
    row('Includes VAT at 20%', gbp(x.vatIncluded));
    if (x.payment) row(x.kind === 'credit_note' ? 'Refunded to' : 'Paid with', x.payment.description);
    if (x.kind === 'credit_note') {
      const orig = x.related.find((r) => r.kind === 'receipt');
      if (orig) row('Credit note for receipt', orig.number);
    } else if (x.refunded) {
      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').fontSize(10).text('REFUNDED - see the linked credit note. This receipt is unchanged.', 50, doc.y, { width: W });
    }
    doc.moveDown(1.5);
    doc.font('Helvetica').fontSize(8).fillColor('#000').text(
      'Thank you for travelling with Private Hire Cars. Keep this document for your records. We keep booking records for 12 months.',
      50,
      doc.y,
      { width: W },
    );
    doc.end();
  });
}

/** Email attachments for queued notifications that carry a receipt (built at delivery time). */
setAttachmentBuilder(async (n) => {
  const doc = await loadReceiptDoc(null, n.receipt_id);
  if (!doc) return [];
  return [{ filename: n.attachment_name || pdfName(doc.booking.ref), content: await renderPdf(serializeReceiptDoc(doc)), contentType: 'application/pdf' }];
});

/**
 * N38: email the receipt with the PDF attached, to the customer's own address or another one.
 * Manual sends are limited to 3 per booking per hour; automatic sends (FR-6.6) do not count.
 */
export async function sendReceipt(db, { receiptId, to, sentBy = null, automatic = false }) {
  const run = db ? db.query.bind(db) : query;
  const doc = await loadReceiptDoc(db, receiptId);
  if (!doc) throw new HttpError(404, 'Receipt not found', 'not_found');
  if (!automatic) {
    const { rows } = await run(
      "SELECT count(*)::int AS n FROM receipt_sends WHERE booking_id=$1 AND NOT automatic AND created_at > now() - interval '1 hour'",
      [doc.r.booking_id],
    );
    if (rows[0].n >= SEND_LIMIT_PER_HOUR) {
      throw new HttpError(429, 'You can send this receipt 3 times an hour. Please try again later.', 'send_limit');
    }
  }
  const x = serializeReceiptDoc(doc);
  const title = x.kind === 'credit_note' ? 'Credit note' : 'Receipt';
  const n = await sendEmail(
    {
      userId: doc.customer.id,
      to,
      kind: x.kind === 'credit_note' ? 'credit_note' : 'receipt',
      bookingId: doc.r.booking_id,
      sentBy,
      receiptId: doc.r.id,
      attachmentName: x.pdfName,
      subject: `${title} ${x.number} - booking ${x.booking.ref}`,
      body:
        `Hello ${doc.customer.full_name},\n\n` +
        `Please find your ${title.toLowerCase()} ${x.number} for booking ${x.booking.ref} attached as a PDF.\n\n` +
        `${x.booking.pickup} to ${x.booking.destination}\n` +
        `${x.kind === 'credit_note' ? 'Refunded' : 'Paid'}: ${gbp(x.amount)}${x.payment ? ` (${x.payment.description})` : ''}\n\n` +
        'The Private Hire Cars team',
    },
    db,
  );
  await run(
    'INSERT INTO receipt_sends (receipt_id, booking_id, to_addr, sent_by, notification_id, automatic) VALUES ($1,$2,$3,$4,$5,$6)',
    [doc.r.id, doc.r.booking_id, to, sentBy, n.id, automatic],
  );
  return n;
}

/** Create the receipt or credit note for a payment and email it to the customer straight away (FR-6.6). */
export async function issueAndSend(db, payment) {
  const r = await receiptForPayment(db, payment);
  if (!r) return null;
  const { rows } = await db.query('SELECT email FROM users WHERE id=$1', [r.customer_id]);
  await sendReceipt(db, { receiptId: r.id, to: rows[0].email, automatic: true });
  return r;
}

export const brandLabel = (b) => BRAND_LABEL[b] || b;
