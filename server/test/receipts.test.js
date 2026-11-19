import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let t;
let cust;
let staff;
let admin;
let booking;
before(async () => {
  t = await startServer();
  cust = await t.login('customer@privatehire.test', 'Customer123!');
  staff = await t.login('staff@privatehire.test', 'StaffPass123!', true);
  admin = await t.login('admin@privatehire.test', 'AdminPass123!', true);
});
after(() => t.close());

const day = (n, h = 11) => {
  const d = new Date(Date.now() + n * 86400_000);
  d.setUTCHours(h, 0, 0, 0);
  return d.toISOString();
};
const CARD = { method: 'card', card: { number: '4242 4242 4242 4242', expMonth: 12, expYear: 2031, cvv: '123', holder: 'Alex Morgan' } };
const trip = (over = {}) => ({ serviceCode: 'local', pickup: 'Camden Town', destination: 'Brixton', pickupAt: day(4), passengers: 2, sizeCode: 'saloon', payment: CARD, ...over });
const deliver = () => t.call('POST', '/admin/jobs/deliver', { token: admin });

test('FR-6.1, FR-6.6, FR-6.7 paying creates one receipt in the history and emails it automatically with the PDF', async () => {
  const r = await t.book(cust, trip());
  assert.equal(r.status, 201);
  booking = r.body.booking;
  const list = await t.call('GET', '/receipts', { token: cust });
  assert.equal(list.status, 200);
  const mine = list.body.receipts.filter((x) => x.bookingId === booking.id);
  assert.equal(mine.length, 1, 'created once');
  assert.equal(mine[0].status, 'Paid');
  assert.match(mine[0].number, /^RC-/);
  const auto = await t.pool.query("SELECT * FROM notifications WHERE kind='receipt' AND booking_id=$1", [booking.id]);
  assert.equal(auto.rowCount, 1);
  assert.equal(auto.rows[0].attachment_name, `PrivateHire-receipt-${booking.ref}.pdf`);
  await deliver();
  assert.equal((await t.pool.query('SELECT status FROM notifications WHERE id=$1', [auto.rows[0].id])).rows[0].status, 'sent');
});

test('FR-6.1 the receipt shows the reference, journey, discount, final cost, card brand and last 4 only, date paid', async () => {
  const id = (await t.call('GET', '/receipts', { token: cust })).body.receipts.find((x) => x.bookingId === booking.id).id;
  const r = await t.call('GET', `/receipts/${id}`, { token: cust });
  const x = r.body.receipt;
  assert.equal(x.booking.ref, booking.ref);
  assert.equal(x.booking.pickup, 'Camden Town');
  assert.ok(x.price.discountOnline > 0);
  assert.equal(x.amount, booking.price.total);
  assert.equal(x.payment.description, 'Visa ending 4242');
  assert.ok(x.createdAt);
  assert.ok(x.vatIncluded > 0, 'VAT shown for business customers');
  assert.ok(!JSON.stringify(x).includes('4242424242424242'));
});

test('FR-6.4 Save as PDF downloads PrivateHire-receipt-<reference>.pdf', async () => {
  const id = (await t.call('GET', '/receipts', { token: cust })).body.receipts.find((x) => x.bookingId === booking.id).id;
  const res = await fetch(`${t.url}/receipts/${id}/pdf`, { headers: { Authorization: `Bearer ${cust}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), new RegExp(`attachment; filename="PrivateHire-receipt-${booking.ref}.pdf"`));
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
});

test('FR-6.2 only the owner or staff can open a receipt', async () => {
  const id = (await t.call('GET', '/receipts', { token: cust })).body.receipts.find((x) => x.bookingId === booking.id).id;
  await t.register({ fullName: 'Pat Other', email: 'pat@example.com', phone: '07700 900321', addressLine: '2 Road', city: 'London', postcode: 'N1 9GU', password: 'Passw0rd1234' });
  const other = await t.login('pat@example.com', 'Passw0rd1234');
  assert.equal((await t.call('GET', `/receipts/${id}`, { token: other })).status, 404);
  assert.equal((await fetch(`${t.url}/receipts/${id}/pdf`, { headers: { Authorization: `Bearer ${other}` } })).status, 404);
  assert.equal((await t.call('GET', '/receipts', { token: other })).body.receipts.length, 0);
});

test('FR-6.5 send the receipt to my address or another one; 3 sends per booking per hour; the send log is kept', async () => {
  const id = (await t.call('GET', '/receipts', { token: cust })).body.receipts.find((x) => x.bookingId === booking.id).id;
  const bad = await t.call('POST', `/receipts/${id}/send`, { token: cust, body: { to: 'not-an-email' } });
  assert.equal(bad.status, 400);
  assert.equal((await t.call('POST', `/receipts/${id}/send`, { token: cust, body: {} })).status, 202);
  assert.equal((await t.call('POST', `/receipts/${id}/send`, { token: cust, body: { to: 'accounts@example.com' } })).status, 202);
  assert.equal((await t.call('POST', `/receipts/${id}/send`, { token: cust, body: { to: 'nobody@fail.test' } })).status, 202);
  const fourth = await t.call('POST', `/receipts/${id}/send`, { token: cust, body: {} });
  assert.equal(fourth.status, 429);
  await deliver();
  const doc = (await t.call('GET', `/receipts/${id}`, { token: cust })).body.receipt;
  const byTo = Object.fromEntries(doc.sends.map((s) => [s.to, s]));
  assert.equal(byTo['accounts@example.com'].status, 'sent');
  assert.equal(byTo['nobody@fail.test'].status, 'failed', 'shown as Failed after the retries');
  assert.equal(byTo['nobody@fail.test'].attempts, 3, 'retried 3 times');
  assert.ok(doc.sends.some((s) => s.automatic));
});

test('ID-44, ID-47 a failed message is retried 3 times, then shown on the notifications page and to staff', async () => {
  const mine = await t.call('GET', '/notifications?status=failed', { token: cust });
  assert.ok(mine.body.notifications.length >= 1);
  assert.equal(mine.body.notifications[0].attempts, 3);
  assert.ok(mine.body.notifications[0].error);
  const dash = await t.call('GET', '/staff/dashboard', { token: staff });
  assert.ok(dash.body.stats.failedMessages >= 1);
});

test('FR-6.8 a refund adds a linked credit note; the original receipt is unchanged and shows Refunded', async () => {
  const before = (await t.call('GET', '/receipts', { token: cust })).body.receipts.find((x) => x.bookingId === booking.id);
  assert.equal((await t.call('POST', `/bookings/${booking.id}/cancel`, { token: cust, body: {} })).status, 200);
  const after = (await t.call('GET', '/receipts', { token: cust })).body.receipts.filter((x) => x.bookingId === booking.id);
  const orig = after.find((x) => x.kind === 'receipt');
  const credit = after.find((x) => x.kind === 'credit_note');
  assert.equal(orig.amount, before.amount, 'the original is unchanged');
  assert.equal(orig.status, 'Refunded');
  assert.equal(credit.relatedNumber, orig.number);
  assert.match(credit.number, /^CN-/);
  assert.equal(after[0].kind, 'credit_note', 'newest first');
});

test('FR-6.7 history filters by date range and searches by reference', async () => {
  const b2 = (await t.book(cust, trip({ pickupAt: day(6) }))).body.booking;
  const byRef = await t.call('GET', `/receipts?q=${b2.ref.slice(3)}`, { token: cust });
  assert.ok(byRef.body.receipts.length >= 1 && byRef.body.receipts.every((x) => x.ref === b2.ref));
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  assert.ok((await t.call('GET', `/receipts?from=${today}&to=${tomorrow}`, { token: cust })).body.receipts.length >= 2);
  assert.equal((await t.call('GET', '/receipts?from=2020-01-01&to=2020-01-31', { token: cust })).body.receipts.length, 0);
});

test('FR-6.10 staff open a verified customer\'s receipt history, and the view is logged', async () => {
  const id = (await t.pool.query("SELECT id FROM users WHERE email='customer@privatehire.test'")).rows[0].id;
  const blocked = await t.call('GET', `/staff/customers/${id}/receipts`, { token: staff });
  assert.equal(blocked.status, 403, 'caller must be verified first');
  const v = await t.call('POST', `/staff/customers/${id}/verify`, { token: staff, body: { answers: { postcode: 'SW1A 2AA', phoneLast4: '0123' }, confirmed: true } });
  assert.equal(v.body.verified, true, JSON.stringify(v.body));
  const r = await t.call('GET', `/staff/customers/${id}/receipts`, { token: staff });
  assert.equal(r.status, 200);
  assert.ok(r.body.receipts.length >= 2);
  const log = await t.pool.query("SELECT staff_name FROM audit_log WHERE action='receipt.history.view' AND target_id=$1", [id]);
  assert.equal(log.rows[0].staff_name, 'Sam Carter');
});

test('N19 a reminder is sent about 24 hours before the journey, once', async () => {
  const b = (await t.book(cust, trip({ pickupAt: new Date(Date.now() + 26 * 3600_000).toISOString(), notifyPref: 'both' }))).body.booking;
  await t.pool.query("UPDATE bookings SET pickup_at = now() + interval '24 hours', end_at = now() + interval '25 hours' WHERE id=$1", [b.id]);
  const r1 = await t.call('POST', '/admin/jobs/reminders', { token: admin });
  assert.ok(r1.body.done >= 1);
  const msgs = await t.pool.query("SELECT channel FROM notifications WHERE kind='reminder' AND booking_id=$1 ORDER BY channel", [b.id]);
  assert.deepEqual(msgs.rows.map((m) => m.channel), ['email', 'sms']);
  await t.call('POST', '/admin/jobs/reminders', { token: admin });
  assert.equal((await t.pool.query("SELECT 1 FROM notifications WHERE kind='reminder' AND booking_id=$1", [b.id])).rowCount, 2, 'not sent twice');
});

test('N21 share my trip: a private link with the car and driver first name only; it can be turned off', async () => {
  const b = (await t.book(cust, trip({ pickupAt: day(8) }))).body.booking;
  const s = await t.call('POST', `/bookings/${b.id}/share`, { token: cust, body: { contact: 'friend@example.com' } });
  assert.equal(s.status, 201);
  const token = s.body.url.split('/track/')[1];
  const pub = await t.call('GET', `/track/${token}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.trip.status, 'confirmed');
  assert.ok(!JSON.stringify(pub.body).includes('customer@privatehire.test'), 'no personal data');
  assert.equal((await t.pool.query("SELECT 1 FROM notifications WHERE kind='trip_share' AND to_addr='friend@example.com'")).rowCount, 1);
  await t.call('DELETE', `/bookings/${b.id}/share`, { token: cust });
  assert.equal((await t.call('GET', `/track/${token}`)).status, 404);
});

test('N20, N22 problem with my journey and the emergency button alert staff; staff mark it handled', async () => {
  const b = (await t.book(cust, trip({ pickupAt: day(9) }))).body.booking;
  const e = await t.call('POST', `/bookings/${b.id}/incident`, { token: cust, body: { kind: 'emergency', message: 'Driver unwell' } });
  assert.equal(e.status, 201);
  assert.match(e.body.message, /999/);
  const list = await t.call('GET', '/staff/incidents', { token: staff });
  const inc = list.body.incidents.find((i) => i.booking.id === b.id);
  assert.equal(inc.kind, 'emergency');
  assert.equal((await t.call('GET', '/staff/dashboard', { token: staff })).body.stats.openIncidents, 1);
  assert.equal((await t.call('POST', `/staff/incidents/${inc.id}/handle`, { token: staff })).status, 200);
  assert.equal((await t.call('GET', '/staff/dashboard', { token: staff })).body.stats.openIncidents, 0);
});
