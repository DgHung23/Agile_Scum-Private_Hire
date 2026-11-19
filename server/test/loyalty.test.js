import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let t;
let staff;
let admin;
let cust;
let customerId;
before(async () => {
  t = await startServer();
  staff = await t.login('staff@privatehire.test', 'StaffPass123!', true);
  admin = await t.login('manager@privatehire.test', 'ManagerPass123!', true);
  cust = await t.login('customer@privatehire.test', 'Customer123!');
  customerId = (await t.pool.query("SELECT id FROM users WHERE email='customer@privatehire.test'")).rows[0].id;
});
after(() => t.close());

const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const PAY = { method: 'card', card: { number: '4242 4242 4242 4242', expMonth: 12, expYear: 2031, cvv: '123', holder: 'Alex Morgan' } };
const book = async (over = {}, token = cust) => {
  const r = await t.book(token, { serviceCode: 'local', pickup: 'Brixton', destination: 'Shoreditch', pickupAt: inHours(72), passengers: 2, sizeCode: 'saloon', notifyPref: 'email', payment: PAY, ...over });
  return r;
};
const complete = async (b) => {
  const opt = await t.call('GET', `/staff/bookings/${b.id}/options`, { token: staff });
  await t.call('POST', `/staff/bookings/${b.id}/assign`, { token: staff, body: { driverId: opt.body.drivers[0].id } });
  const r = await t.call('POST', `/staff/bookings/${b.id}/status`, { token: staff, body: { status: 'completed' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
};
const dateIn = (days) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

/* ---------------- reviews ---------------- */

test('US7.1 reviews are only allowed once the journey is Completed, with three ratings, once per booking', async () => {
  const b = (await book({ pickupAt: inHours(48) })).body.booking;
  const early = await t.call('POST', `/bookings/${b.id}/review`, { token: cust, body: { journeyRating: 5, cabRating: 5, driverRating: 5 } });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'not_completed');
  await complete(b);
  const bad = await t.call('POST', `/bookings/${b.id}/review`, { token: cust, body: { journeyRating: 6, cabRating: 0 } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.fields.journeyRating && bad.body.error.fields.cabRating && bad.body.error.fields.driverRating);
  const ok = await t.call('POST', `/bookings/${b.id}/review`, { token: cust, body: { journeyRating: 5, cabRating: 4, driverRating: 3, comment: 'Smooth ride, a bit warm in the car.' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.review.cabRating, 4);
  const again = await t.call('POST', `/bookings/${b.id}/review`, { token: cust, body: { journeyRating: 1, cabRating: 1, driverRating: 1 } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'already_reviewed');
  const detail = await t.call('GET', `/bookings/${b.id}`, { token: cust });
  assert.equal(detail.body.review.driverRating, 3);
});

test('US7.1 only the customer who travelled can review', async () => {
  const b = (await book({ pickupAt: inHours(49) })).body.booking;
  await complete(b);
  await t.register({ fullName: 'Pat Other', email: 'pat@example.com', phone: '07700 900321', addressLine: '2 Road', city: 'London', postcode: 'N1 9GU', password: 'Passw0rd1234' });
  const other = await t.login('pat@example.com', 'Passw0rd1234');
  assert.equal((await t.call('POST', `/bookings/${b.id}/review`, { token: other, body: { journeyRating: 1, cabRating: 1, driverRating: 1 } })).status, 404);
  assert.equal((await t.call('POST', `/bookings/${b.id}/review`, { token: staff, body: { journeyRating: 5, cabRating: 5, driverRating: 5 } })).status, 403);
});

test('US7.2 staff see reviews and averages by driver and by cab, low ratings flagged', async () => {
  const b = (await book({ pickupAt: inHours(50) })).body.booking;
  await complete(b);
  await t.call('POST', `/bookings/${b.id}/review`, { token: cust, body: { journeyRating: 1, cabRating: 2, driverRating: 1, comment: 'Late and rude.' } });
  assert.equal((await t.call('GET', '/staff/reviews/summary', { token: cust })).status, 403);
  const sum = await t.call('GET', '/staff/reviews/summary', { token: staff });
  assert.equal(sum.status, 200);
  assert.equal(sum.body.overall.reviews, 2);
  assert.ok(sum.body.drivers.length >= 1 && sum.body.cabs.length >= 1);
  assert.ok(sum.body.drivers.some((d) => d.needsAttention), 'a 1-star driver is flagged');
  const low = await t.call('GET', '/staff/reviews?maxRating=2', { token: staff });
  assert.equal(low.body.reviews.length, 1);
  assert.equal(low.body.reviews[0].comment, 'Late and rude.');
  assert.ok(low.body.reviews[0].driverName && low.body.reviews[0].cab);
});

/* ---------------- offers ---------------- */

let offer;
test('ID-71, ID-72 the Manager creates a fixed-amount coupon and sends it only to opted-in customers', async () => {
  const bad = await t.call('POST', '/staff/offers', { token: admin, body: { title: 'x', amount: 80, expiresOn: 'soon', customerIds: [] } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.fields.amount && bad.body.error.fields.expiresOn && bad.body.error.fields.customerIds);
  const past = await t.call('POST', '/staff/offers', { token: admin, body: { title: 'Old offer', amount: 5, expiresOn: dateIn(-3), customerIds: [customerId] } });
  assert.equal(past.status, 400);
  assert.ok(past.body.error.fields.expiresOn);
  const patId = (await t.pool.query("SELECT id FROM users WHERE email='pat@example.com'")).rows[0].id;
  const noConsent = await t.call('POST', '/staff/offers', { token: admin, body: { title: 'For Pat', amount: 5, expiresOn: dateIn(5), customerIds: [patId] } });
  assert.equal(noConsent.status, 400, 'Pat did not opt in to offers');

  const ok = await t.call('POST', '/staff/offers', { token: admin, body: { code: 'welcome5', title: 'GBP 5 off your next airport run', amount: 5, expiresOn: dateIn(14), customerIds: [customerId, patId] } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.offer.code, 'WELCOME5');
  assert.equal(ok.body.offer.amount, 5);
  assert.equal(ok.body.sent, 1, 'only the opted-in customer receives it');
  offer = ok.body.offer;
  const mail = await t.pool.query("SELECT * FROM notifications WHERE kind='offer' AND to_addr='customer@privatehire.test'");
  assert.equal(mail.rowCount, 1);
  assert.ok(mail.rows[0].body.includes('WELCOME5') && mail.rows[0].body.includes('GBP 5.00'));
  assert.equal((await t.call('POST', '/staff/offers', { token: admin, body: { code: 'WELCOME5', title: 'dup offer', amount: 5, expiresOn: dateIn(5), customerIds: [customerId] } })).status, 409);
  assert.equal((await t.call('POST', '/staff/offers', { token: cust, body: {} })).status, 403);
  assert.equal((await t.call('POST', '/staff/offers', { token: staff, body: {} })).status, 403, 'Call Centre Staff cannot create offers');
});

test('ID-73 the coupon is in the wallet (My coupons) and can be checked', async () => {
  const mine = await t.call('GET', '/offers/mine', { token: cust });
  assert.deepEqual(mine.body.offers.map((o) => o.code), ['WELCOME5']);
  const v = await t.call('POST', '/offers/validate', { token: cust, body: { code: ' welcome5 ' } });
  assert.equal(v.status, 200);
  assert.equal(v.body.offer.amount, 5);
  const nope = await t.call('POST', '/offers/validate', { token: cust, body: { code: 'NOPE1234' } });
  assert.equal(nope.status, 400);
  assert.ok(nope.body.error.fields.offerCode);
});

test('ID-73 a coupon that belongs to other customers looks like an invalid code', async () => {
  const other = await t.login('pat@example.com', 'Passw0rd1234');
  const r = await t.call('POST', '/offers/validate', { token: other, body: { code: 'WELCOME5' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.fields.offerCode, 'That coupon code is not valid. Check it and try again.');
  assert.equal((await t.call('GET', '/offers/mine', { token: other })).body.offers.length, 0);
});

test('ID-31, ID-73 the coupon comes off after the 15% online discount', async () => {
  const q = { serviceCode: 'local', pickup: 'Brixton', destination: 'Shoreditch', pickupAt: inHours(80), passengers: 2 };
  const plain = (await t.call('POST', '/bookings/quote', { token: cust, body: q })).body.sizes[0].price;
  const withOffer = await t.call('POST', '/bookings/quote', { token: cust, body: { ...q, offerCode: 'welcome5' } });
  assert.equal(withOffer.status, 200);
  const p = withOffer.body.sizes[0].price;
  assert.equal(withOffer.body.offer.code, 'WELCOME5');
  assert.equal(p.full, plain.full);
  assert.equal(p.discountOnline, plain.discountOnline);
  assert.equal(p.discountOffer, 5);
  assert.equal(p.total, Math.round((plain.total - 5) * 100) / 100);
  assert.equal((await t.call('POST', '/bookings/quote', { body: { ...q, offerCode: 'WELCOME5' } })).status, 400, 'anonymous quotes cannot use coupons');
});

let used;
test('ID-73 booking with the coupon applies it once, records the applied discounts, and it can only be used once', async () => {
  const r = await book({ pickupAt: inHours(90), offerCode: 'WELCOME5' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  used = r.body.booking;
  assert.equal(used.price.offerCode, 'WELCOME5');
  assert.equal(used.price.discountOffer, 5);
  assert.equal(r.body.payment.amount, used.price.total, 'charged the discounted total');
  assert.equal((await t.pool.query('SELECT 1 FROM coupon_redemptions')).rowCount, 1);
  const applied = (await t.pool.query('SELECT kind, sequence FROM applied_discounts WHERE booking_id=$1 ORDER BY sequence', [used.id])).rows;
  assert.deepEqual(applied.map((a) => a.kind), ['programme', 'coupon']);
  const rc = (await t.call('GET', `/bookings/${used.id}/receipt`, { token: cust })).body.receipt;
  assert.equal(rc.price.offerCode, 'WELCOME5');

  const again = await book({ pickupAt: inHours(91), offerCode: 'WELCOME5' });
  assert.equal(again.status, 400);
  assert.equal(again.body.error.fields.offerCode, 'You have already used that coupon.');
  assert.equal((await t.call('GET', '/offers/mine', { token: cust })).body.offers.length, 0, 'used coupons leave My coupons');
});

test('ID-73 cancelling the booking gives the coupon back; amending keeps the same amount off', async () => {
  const am = await t.call('POST', `/bookings/${used.id}/amend`, { token: cust, body: { pickup: used.pickup, destination: used.destination, pickupAt: used.pickupAt, passengers: 2, sizeCode: 'estate' } });
  assert.equal(am.status, 200, JSON.stringify(am.body));
  assert.equal(am.body.booking.price.offerCode, 'WELCOME5');
  assert.equal(am.body.booking.price.discountOffer, 5, 'coupon still applied after amending');
  assert.equal((await t.call('POST', `/bookings/${used.id}/cancel`, { token: cust, body: {} })).status, 200);
  assert.equal((await t.call('GET', '/offers/mine', { token: cust })).body.offers.length, 1, 'coupon is usable again');
});

test('ID-73 expired and deactivated coupons are rejected', async () => {
  await t.call('POST', '/staff/offers', { token: admin, body: { code: 'SOON1234', title: 'Short offer', amount: 3, expiresOn: dateIn(1), customerIds: [customerId] } });
  await t.pool.query("UPDATE coupons SET expires_at = now() - interval '1 hour' WHERE code='SOON1234'");
  const exp = await t.call('POST', '/offers/validate', { token: cust, body: { code: 'SOON1234' } });
  assert.equal(exp.body.error.fields.offerCode, 'That coupon has expired.');
  const id = (await t.pool.query("SELECT id FROM coupons WHERE code='WELCOME5'")).rows[0].id;
  assert.equal((await t.call('POST', `/staff/offers/${id}/deactivate`, { token: admin })).status, 200);
  assert.equal((await t.call('POST', '/offers/validate', { token: cust, body: { code: 'WELCOME5' } })).status, 400);
});

test('R14 recommendations: personal coupons for opted-in repeat customers, based on what they book most', async () => {
  const before = (await t.pool.query('SELECT count(*)::int AS n FROM coupons')).rows[0].n;
  const r = await t.call('POST', '/staff/offers/recommend', { token: admin, body: { amount: 4, validDays: 30, minTrips: 2 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.sent, 1, 'only the demo customer has 2+ trips and opted in');
  const after = (await t.pool.query('SELECT count(*)::int AS n FROM coupons')).rows[0].n;
  assert.equal(after, before + 1);
  const mail = (await t.pool.query("SELECT body FROM notifications WHERE kind='offer' ORDER BY created_at DESC LIMIT 1")).rows[0];
  assert.match(mail.body, /often book Local journey/);
  const again = await t.call('POST', '/staff/offers/recommend', { token: admin, body: { minTrips: 2 } });
  assert.equal(again.body.sent, 0, 'not sent twice while a reward is still valid');
});

/* ---------------- reports ---------------- */

test('US10.2 loyal customers ranked by trips and spend, with tiers', async () => {
  const r = await t.call('GET', '/staff/customers-loyalty?minTrips=1', { token: admin });
  assert.equal(r.status, 200);
  const top = r.body.customers[0];
  assert.equal(top.fullName, 'Alex Morgan');
  assert.ok(top.trips >= 3 && top.spend > 0);
  assert.equal(top.favouriteService, 'Local journey');
  assert.ok(['Bronze', 'Silver', 'Gold'].includes(top.tier));
  assert.ok(r.body.customers.every((c, i, a) => i === 0 || a[i - 1].trips >= c.trips), 'sorted by trips');
  assert.equal((await t.call('GET', '/staff/customers-loyalty', { token: cust })).status, 403);
});

test('US10.1 popular cars and sizes: manager only', async () => {
  assert.equal((await t.call('GET', '/staff/reports/popular', { token: staff })).status, 403, 'call-centre staff are not managers');
  const r = await t.call('GET', '/staff/reports/popular?days=30', { token: admin });
  assert.equal(r.status, 200);
  assert.ok(r.body.totals.bookings >= 3);
  assert.ok(r.body.topCabs.length > 0 && r.body.topCabs[0].bookings >= 1);
  assert.ok(r.body.bySize.find((s) => s.size.startsWith('Saloon')));
  assert.ok(r.body.byChannel.find((c) => c.channel === 'online'));
  assert.ok(r.body.topCabs.every((c, i, a) => i === 0 || a[i - 1].bookings >= c.bookings));
  const total = r.body.bySize.reduce((a, s) => a + s.bookings, 0);
  assert.equal(total, r.body.totals.bookings, 'sizes add up to the total');
});

/* ---------------- password reset ---------------- */

test('US1.6 forgot password: same answer for known and unknown emails; reset link works once', async () => {
  const known = await t.call('POST', '/auth/forgot', { body: { email: 'customer@privatehire.test' } });
  const unknown = await t.call('POST', '/auth/forgot', { body: { email: 'nobody@example.com' } });
  assert.equal(known.status, 200);
  assert.deepEqual(known.body, unknown.body);
  assert.equal((await t.pool.query("SELECT 1 FROM notifications WHERE kind='password_reset'")).rowCount, 1);
  const mail = (await t.pool.query("SELECT body FROM notifications WHERE kind='password_reset'")).rows[0].body;
  const token = mail.match(/token=([A-Za-z0-9_-]+)/)[1];

  assert.equal((await t.call('POST', '/auth/reset', { body: { token, password: 'short' } })).status, 400);
  assert.equal((await t.call('POST', '/auth/reset', { body: { token: 'x'.repeat(30), password: 'NewPassw0rd123' } })).status, 400);
  const ok = await t.call('POST', '/auth/reset', { body: { token, password: 'NewPassw0rd123' } });
  assert.equal(ok.status, 200);
  assert.ok(await t.login('customer@privatehire.test', 'NewPassw0rd123'));
  assert.equal(await t.login('customer@privatehire.test', 'Customer123!'), undefined, 'old password no longer works');
  const reuse = await t.call('POST', '/auth/reset', { body: { token, password: 'AnotherPassw0rd' } });
  assert.equal(reuse.status, 400, 'a reset link works only once');
  assert.equal((await t.pool.query("SELECT 1 FROM notifications WHERE kind='password_changed'")).rowCount, 1);
});

test('US1.6 expired reset links are refused', async () => {
  await t.call('POST', '/auth/forgot', { body: { email: 'pat@example.com' } });
  const mail = (await t.pool.query("SELECT body FROM notifications WHERE kind='password_reset' AND to_addr='pat@example.com'")).rows[0].body;
  const token = mail.match(/token=([A-Za-z0-9_-]+)/)[1];
  await t.pool.query("UPDATE password_resets SET expires_at = now() - interval '1 minute'");
  const r = await t.call('POST', '/auth/reset', { body: { token, password: 'NewPassw0rd123' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /expired/);
});
