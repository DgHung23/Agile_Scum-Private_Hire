import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let t;
let staff;
let cust;
let customerId;
before(async () => {
  t = await startServer();
  staff = await t.login('staff@privatehire.test', 'StaffPass123!', true);
  cust = await t.login('customer@privatehire.test', 'Customer123!');
  customerId = (await t.pool.query("SELECT id FROM users WHERE email='customer@privatehire.test'")).rows[0].id;
});
after(() => t.close());

const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const journey = (over = {}) => ({
  serviceCode: 'local', pickup: 'Victoria Station', destination: 'Greenwich', pickupAt: inHours(48), passengers: 3,
  sizeCode: 'saloon', channel: 'phone', notifyPref: 'email', ...over,
});

test('US9.2 call-desk endpoints are staff only', async () => {
  assert.equal((await t.call('GET', '/staff/customers/search?q=alex')).status, 401);
  assert.equal((await t.call('GET', '/staff/customers/search?q=alex', { token: cust })).status, 403);
});

test('US9.2 search finds by name, phone, email and booking ref - and masks personal data', async () => {
  const byName = await t.call('GET', '/staff/customers/search?q=morgan', { token: staff });
  assert.equal(byName.body.customers.length, 1);
  const c = byName.body.customers[0];
  assert.equal(c.fullName, 'Alex Morgan');
  assert.match(c.maskedEmail, /^c\*+@p\*+\.test$/);
  assert.equal(c.maskedPhone, '•••• 0123');
  assert.equal(c.email, undefined);
  assert.equal(c.phone, undefined);
  assert.equal(c.postcode, undefined);
  assert.equal((await t.call('GET', '/staff/customers/search?q=07700%20900123', { token: staff })).body.customers.length, 1);
  assert.equal((await t.call('GET', '/staff/customers/search?q=customer@privatehire', { token: staff })).body.customers.length, 1);
  assert.equal((await t.call('GET', '/staff/customers/search?q=nobody-here', { token: staff })).body.customers.length, 0);
  assert.equal((await t.call('GET', '/staff/customers/search?q=a', { token: staff })).status, 400);
  assert.equal((await t.call('GET', '/staff/customers/search?q=staff@privatehire', { token: staff })).body.customers.length, 0, 'staff accounts are not returned');
});

test('US9.2 the account stays closed until the caller is verified', async () => {
  const r = await t.call('GET', `/staff/customers/${customerId}`, { token: staff });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'not_verified');
});

test('US9.2 verification: needs 2 matching answers AND the "identity verified" confirmation', async () => {
  const one = await t.call('POST', `/staff/customers/${customerId}/verify`, { token: staff, body: { answers: { postcode: 'sw1a 2aa' }, confirmed: true } });
  assert.equal(one.body.verified, false);
  assert.equal(one.body.matched, 1);
  const wrong = await t.call('POST', `/staff/customers/${customerId}/verify`, { token: staff, body: { answers: { postcode: 'E1 1AA', phoneLast4: '9999' }, confirmed: true } });
  assert.equal(wrong.body.verified, false);
  assert.equal(wrong.body.matched, 0);
  assert.deepEqual(wrong.body.results, { postcode: false, phone_last4: false }, 'reveals which checks failed, never the right answer');

  const noTick = await t.call('POST', `/staff/customers/${customerId}/verify`, { token: staff, body: { answers: { postcode: 'SW1A 2AA', phoneLast4: '0123' } } });
  assert.equal(noTick.body.verified, false);
  assert.equal(noTick.body.awaitingConfirmation, true);
  assert.equal((await t.call('GET', `/staff/customers/${customerId}`, { token: staff })).status, 403, 'still closed without the confirmation');

  const ok = await t.call('POST', `/staff/customers/${customerId}/verify`, { token: staff, body: { answers: { postcode: 'sw1a 2aa', phoneLast4: '0123', houseNumber: '10' }, confirmed: true } });
  assert.equal(ok.body.verified, true);
  assert.equal(ok.body.matched, 3);
  const open = await t.call('GET', `/staff/customers/${customerId}`, { token: staff });
  assert.equal(open.status, 200);
  assert.equal(open.body.customer.email, 'customer@privatehire.test');
  const audit = await t.pool.query('SELECT verified, reason FROM caller_verifications WHERE customer_id=$1 ORDER BY created_at', [customerId]);
  assert.ok(audit.rows.some((a) => a.verified) && audit.rows.some((a) => !a.verified), 'successful and failed attempts are both recorded');
});

test('US9.2 verification is per staff member and locks after repeated failures', async () => {
  const other = (await t.register({ fullName: 'Lock Test', email: 'lock@example.com', phone: '07700 900555', addressLine: '9 Test Rd', city: 'London', postcode: 'N1 9GU', password: 'Passw0rd1234' })).user;
  const admin = await t.login('manager@privatehire.test', 'ManagerPass123!', true);
  const ok = await t.call('POST', `/staff/customers/${other.id}/verify`, { token: admin, body: { answers: { postcode: 'N1 9GU', phoneLast4: '0555' }, confirmed: true } });
  assert.equal(ok.body.verified, true);
  assert.equal((await t.call('GET', `/staff/customers/${other.id}`, { token: staff })).status, 403, "another staff member's verification does not count");
  for (let i = 0; i < 5; i++) await t.call('POST', `/staff/customers/${other.id}/verify`, { token: staff, body: { answers: { postcode: 'X1 1XX', phoneLast4: '1111' }, confirmed: true } });
  const locked = await t.call('POST', `/staff/customers/${other.id}/verify`, { token: staff, body: { answers: { postcode: 'N1 9GU', phoneLast4: '0555' }, confirmed: true } });
  assert.equal(locked.status, 429);
});

test('US9.3 create an account for a new caller: validated, emailed, immediately verified', async () => {
  const bad = await t.call('POST', '/staff/customers', { token: staff, body: { fullName: '', email: 'x', phone: '1', addressLine: '', city: '', postcode: 'zz' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.fields.email && bad.body.error.fields.postcode);
  const ok = await t.call('POST', '/staff/customers', {
    token: staff,
    body: { fullName: 'Nina New', email: 'nina@example.com', phone: '07700 900777', addressLine: '3 New Road', city: 'London', postcode: 'E2 8AA', signupChannel: 'phone' },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.customer.signupChannel, 'phone');
  const mail = await t.pool.query("SELECT * FROM notifications WHERE to_addr='nina@example.com'");
  assert.equal(mail.rowCount, 1);
  assert.match(mail.rows[0].body, /created a Private Hire Cars account for you/);
  assert.equal(mail.rows[0].sent_by !== null, true);
  assert.equal((await t.call('GET', `/staff/customers/${ok.body.customer.id}`, { token: staff })).status, 200, 'creator can open it straight away');
  const dup = await t.call('POST', '/staff/customers', { token: staff, body: { fullName: 'Nina Again', email: 'NINA@example.com', phone: '07700 900778', addressLine: '3 New Road', city: 'London', postcode: 'E2 8AA' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.existing.fullName, 'Nina New');
  // the generated password is unknown to everyone
  assert.equal((await t.call('POST', '/auth/login', { body: { email: 'nina@example.com', password: 'Password1' } })).status, 401);
});

test('US9.5 staff booking: no 15% discount, channel recorded, not priority, customer emailed', async () => {
  const r = await t.call('POST', '/staff/bookings', { token: staff, body: { ...journey(), customerId } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const b = r.body.booking;
  assert.equal(b.channel, 'phone');
  assert.equal(b.price.discountOnline, 0);
  assert.equal(b.price.total, b.price.full);
  assert.equal(b.priority, false);
  assert.equal(b.paymentStatus, 'unpaid');
  assert.equal(b.customer.email, 'customer@privatehire.test');
  const created = await t.pool.query('SELECT created_by FROM bookings WHERE id=$1', [b.id]);
  assert.ok(created.rows[0].created_by);
  assert.equal((await t.pool.query("SELECT 1 FROM notifications WHERE booking_id=$1 AND kind='booking_confirmed'", [b.id])).rowCount, 1);

  // same journey booked online is exactly 15% cheaper
  const q = await t.call('POST', '/bookings/quote', { body: { serviceCode: 'local', pickup: 'Victoria Station', destination: 'Greenwich', pickupAt: inHours(48), passengers: 3 } });
  const online = q.body.sizes.find((s) => s.code === 'saloon').price;
  assert.equal(online.full, b.price.full);
  assert.equal(online.total, Math.round(b.price.full * 85) / 100);
});

test('US9.5 in-person booking paid in cash is recorded as paid; card payment works the same as online', async () => {
  const cash = await t.call('POST', '/staff/bookings', { token: staff, body: { ...journey({ channel: 'in_person', pickupAt: inHours(50) }), customerId, payment: { method: 'cash' } } });
  assert.equal(cash.status, 201, JSON.stringify(cash.body));
  assert.equal(cash.body.booking.channel, 'in_person');
  assert.equal(cash.body.booking.paymentStatus, 'paid');
  assert.equal(cash.body.payment.method, 'cash');
  const card = await t.call('POST', '/staff/bookings', {
    token: staff,
    body: { ...journey({ pickupAt: inHours(52) }), customerId, payment: { method: 'card', card: { number: '5555 5555 5555 4444', expMonth: 11, expYear: 2031, cvv: '123', holder: 'Alex Morgan' } } },
  });
  assert.equal(card.status, 201);
  assert.equal(card.body.payment.cardBrandLabel, 'Mastercard');
  const declined = await t.call('POST', '/staff/bookings', {
    token: staff,
    body: { ...journey({ pickupAt: inHours(54) }), customerId, payment: { method: 'card', card: { number: '4000 0000 0000 0002', expMonth: 11, expYear: 2031, cvv: '123', holder: 'Alex Morgan' } } },
  });
  assert.equal(declined.status, 402);
});

test('US9.5 same checks as online: availability, validation, passenger limits', async () => {
  const bad = await t.call('POST', '/staff/bookings', { token: staff, body: { ...journey({ pickup: 'Camden Town', destination: 'camden town', passengers: 9 }), customerId } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.fields.destination);
  const tooMany = await t.call('POST', '/staff/bookings', { token: staff, body: { ...journey({ passengers: 6 }), customerId } });
  assert.equal(tooMany.status, 400);
  const noChannel = await t.call('POST', '/staff/bookings', { token: staff, body: { ...journey({ channel: 'online' }), customerId } });
  assert.equal(noChannel.status, 400, 'staff cannot book on the online channel (and get the online discount)');
});

test('US9.2 staff cannot book for a customer they have not verified', async () => {
  const other = (await t.pool.query("SELECT id FROM users WHERE email='lock@example.com'")).rows[0].id;
  const r = await t.call('POST', '/staff/bookings', { token: staff, body: { ...journey(), customerId: other } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'not_verified');
});

test('US9.4 availability with estimated prices per cab', async () => {
  const q = new URLSearchParams({ start: inHours(70), size: 'mpv7', serviceCode: 'airport', pickup: 'Wembley Stadium', destination: 'Heathrow Airport (Terminal 2)' });
  const r = await t.call('GET', `/staff/availability?${q}`, { token: staff });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.cabs.length > 0);
  assert.ok(r.body.cabs.every((c) => c.sizeCode === 'mpv7' && c.estimatedPrice > 0));
  assert.ok(r.body.drivers.length > 0);
  assert.ok(r.body.durationMinutes > 0);
});

test('staff bookings list, detail, and customer-side visibility of staff-made bookings', async () => {
  const list = await t.call('GET', '/staff/bookings?when=upcoming', { token: staff });
  assert.ok(list.body.bookings.length >= 3);
  assert.ok(list.body.bookings.every((b) => b.customer && b.vehicle));
  const one = await t.call('GET', `/staff/bookings/${list.body.bookings[0].id}`, { token: staff });
  assert.equal(one.status, 200);
  const mine = await t.call('GET', '/bookings?when=upcoming', { token: cust });
  assert.ok(mine.body.bookings.some((b) => b.channel === 'phone'), 'the customer sees the booking staff made for them');
  const search = await t.call('GET', `/staff/bookings?when=all&q=${list.body.bookings[0].ref}`, { token: staff });
  assert.equal(search.body.bookings.length, 1);
});

test('R10/R13 staff can cancel inside the 24h window (customers cannot) and the customer is refunded and emailed', async () => {
  const soon = await t.call('POST', '/staff/bookings', { token: staff, body: { ...journey({ pickupAt: inHours(4) }), customerId, payment: { method: 'cash' } } });
  assert.equal(soon.status, 201);
  assert.equal((await t.call('POST', `/bookings/${soon.body.booking.id}/cancel`, { token: cust, body: {} })).status, 409);
  const c = await t.call('POST', `/staff/bookings/${soon.body.booking.id}/cancel`, { token: staff, body: { reason: 'Customer phoned' } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.booking.status, 'cancelled');
  assert.equal(c.body.refund.method, 'cash');
  assert.equal((await t.pool.query("SELECT 1 FROM notifications WHERE kind='booking_cancelled' AND booking_id=$1", [soon.body.booking.id])).rowCount, 1);
});
