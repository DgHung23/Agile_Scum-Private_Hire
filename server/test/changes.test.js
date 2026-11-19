import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let t;
let cust;
let other;
before(async () => {
  t = await startServer();
  cust = await t.login('customer@privatehire.test', 'Customer123!');
  await t.call('POST', '/auth/register', { body: { fullName: 'Pat Other', email: 'pat@example.com', phone: '07700 900321', addressLine: '2 Road', city: 'London', postcode: 'N1 9GU', password: 'Passw0rd1' } });
  other = await t.login('pat@example.com', 'Passw0rd1');
});
after(() => t.close());

const PAY = { method: 'card', card: { number: '4242 4242 4242 4242', expMonth: 12, expYear: 2031, cvv: '123', holder: 'Alex Morgan' } };
const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const base = (over = {}) => ({
  serviceCode: 'local', pickup: 'Paddington Station', destination: 'Canary Wharf', pickupAt: inHours(72), passengers: 2,
  sizeCode: 'saloon', notifyPref: 'email', payment: PAY, ...over,
});
const make = async (over) => {
  const r = await t.call('POST', '/bookings', { token: cust, body: base(over) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.booking;
};

test('US8.1 cancel more than 24h ahead: status, full refund, email, cab freed', async () => {
  const b = await make();
  assert.equal(b.modifiable, true);
  const r = await t.call('POST', `/bookings/${b.id}/cancel`, { token: cust, body: { reason: 'Plans changed' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.booking.status, 'cancelled');
  assert.equal(r.body.refund.kind, 'refund');
  assert.equal(r.body.refund.amount, b.price.total);
  assert.equal(r.body.refund.cardLast4, '4242');
  const row = (await t.pool.query('SELECT payment_status, cancel_reason, driver_id FROM bookings WHERE id=$1', [b.id])).rows[0];
  assert.equal(row.payment_status, 'refunded');
  assert.equal(row.cancel_reason, 'Plans changed');
  const mail = await t.pool.query("SELECT body FROM notifications WHERE kind='booking_cancelled' AND booking_id=$1", [b.id]);
  assert.equal(mail.rowCount, 1);
  assert.match(mail.rows[0].body, /refund of GBP/);
  const rc = await t.call('GET', `/bookings/${b.id}/receipt`, { token: cust });
  assert.equal(rc.body.receipt.netPaid, 0);
  assert.equal(rc.body.receipt.totalRefunded, b.price.total);
});

test('US8.1 criterion 2/3: cancelling twice is refused and a cancelled booking frees its cab', async () => {
  const when = inHours(96);
  const bookings = [];
  for (let i = 0; i < 3; i++) bookings.push(await make({ sizeCode: 'minibus', passengers: 8, pickupAt: when }));
  const full = await t.call('POST', '/bookings', { token: cust, body: base({ sizeCode: 'minibus', passengers: 8, pickupAt: when }) });
  assert.equal(full.status, 409);
  assert.equal((await t.call('POST', `/bookings/${bookings[0].id}/cancel`, { token: cust, body: {} })).status, 200);
  const again = await t.call('POST', `/bookings/${bookings[0].id}/cancel`, { token: cust, body: {} });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'not_modifiable');
  const retry = await t.call('POST', '/bookings', { token: cust, body: base({ sizeCode: 'minibus', passengers: 8, pickupAt: when }) });
  assert.equal(retry.status, 201, 'the released minibus can be booked again');
});

test('R10 cancel and amend are refused inside the 24-hour window', async () => {
  const b = await make({ pickupAt: inHours(5) });
  assert.equal(b.modifiable, false);
  const c = await t.call('POST', `/bookings/${b.id}/cancel`, { token: cust, body: {} });
  assert.equal(c.status, 409);
  assert.equal(c.body.error.code, 'too_late');
  const a = await t.call('POST', `/bookings/${b.id}/amend`, { token: cust, body: { pickup: b.pickup, destination: b.destination, pickupAt: inHours(30), passengers: 2, sizeCode: 'saloon' } });
  assert.equal(a.status, 409);
  assert.equal(a.body.error.code, 'too_late');
  const unchanged = (await t.call('GET', `/bookings/${b.id}`, { token: cust })).body.booking;
  assert.equal(unchanged.status, 'confirmed');
});

test('R10 the window is exactly 24 hours: 25h is allowed, 23h is not', async () => {
  const ok = await make({ pickupAt: inHours(25) });
  const no = await make({ pickupAt: inHours(23) });
  assert.equal(ok.modifiable, true);
  assert.equal(no.modifiable, false);
});

test('ownership: another customer cannot cancel or amend my booking', async () => {
  const b = await make();
  assert.equal((await t.call('POST', `/bookings/${b.id}/cancel`, { token: other, body: {} })).status, 404);
  assert.equal((await t.call('POST', `/bookings/${b.id}/amend`, { token: other, body: { pickup: 'a', destination: 'b', pickupAt: inHours(80), passengers: 1, sizeCode: 'saloon' } })).status, 404);
});

test('US8.2 preview shows the price difference and does not save', async () => {
  const b = await make();
  const body = { pickup: b.pickup, destination: b.destination, pickupAt: b.pickupAt, passengers: 2, sizeCode: 'mpv7' };
  const p = await t.call('POST', `/bookings/${b.id}/amend/preview`, { token: cust, body });
  assert.equal(p.status, 200);
  assert.equal(p.body.available, true);
  assert.equal(p.body.oldTotal, b.price.total);
  assert.ok(p.body.newTotal > p.body.oldTotal);
  assert.equal(p.body.difference, Math.round((p.body.newTotal - p.body.oldTotal) * 100) / 100);
  const same = (await t.call('GET', `/bookings/${b.id}`, { token: cust })).body.booking;
  assert.equal(same.size.code, 'saloon');
});

test('US8.2 amend to a bigger cab and later time: repriced, difference charged, email sent', async () => {
  const b = await make();
  const newTime = inHours(100);
  const r = await t.call('POST', `/bookings/${b.id}/amend`, {
    token: cust,
    body: { pickup: 'Camden Town', destination: 'Heathrow Airport (Terminal 2)', pickupAt: newTime, passengers: 5, sizeCode: 'mpv6' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const nb = r.body.booking;
  assert.equal(nb.pickup, 'Camden Town');
  assert.equal(nb.size.code, 'mpv6');
  assert.equal(nb.passengers, 5);
  assert.equal(new Date(nb.pickupAt).toISOString(), newTime);
  assert.ok(nb.price.total > b.price.total);
  assert.equal(nb.price.discountOnline, Math.round(nb.price.full * 15) / 100, 'online discount still applies after amending');
  assert.equal(r.body.difference, Math.round((nb.price.total - b.price.total) * 100) / 100);
  assert.equal(r.body.settlement.kind, 'charge');
  const rc = (await t.call('GET', `/bookings/${b.id}/receipt`, { token: cust })).body.receipt;
  assert.equal(rc.netPaid, nb.price.total, 'customer has paid exactly the new total');
  const mail = await t.pool.query("SELECT body FROM notifications WHERE kind='booking_amended' AND booking_id=$1", [b.id]);
  assert.match(mail.rows[0].body, /Extra charged: GBP/);
});

test('US8.2 amend to a cheaper cab refunds the difference', async () => {
  const b = await make({ sizeCode: 'mpv7', passengers: 3 });
  const r = await t.call('POST', `/bookings/${b.id}/amend`, {
    token: cust, body: { pickup: b.pickup, destination: b.destination, pickupAt: b.pickupAt, passengers: 3, sizeCode: 'saloon' },
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.difference < 0);
  assert.equal(r.body.settlement.kind, 'refund');
  const rc = (await t.call('GET', `/bookings/${b.id}/receipt`, { token: cust })).body.receipt;
  assert.equal(rc.netPaid, r.body.booking.price.total);
});

test('US8.2 criterion 2: amending re-checks availability and keeps the old booking if nothing is free', async () => {
  const when = inHours(130);
  for (let i = 0; i < 3; i++) await make({ sizeCode: 'minibus', passengers: 8, pickupAt: when });
  const b = await make({ pickupAt: inHours(140) });
  const r = await t.call('POST', `/bookings/${b.id}/amend`, {
    token: cust, body: { pickup: b.pickup, destination: b.destination, pickupAt: when, passengers: 8, sizeCode: 'minibus' },
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'no_availability');
  assert.ok(r.body.error.alternatives);
  const kept = (await t.call('GET', `/bookings/${b.id}`, { token: cust })).body.booking;
  assert.equal(kept.size.code, 'saloon');
  assert.equal(kept.price.total, b.price.total);
  const prev = await t.call('POST', `/bookings/${b.id}/amend/preview`, {
    token: cust, body: { pickup: b.pickup, destination: b.destination, pickupAt: when, passengers: 8, sizeCode: 'minibus' },
  });
  assert.equal(prev.body.available, false);
});

test('US8.2 amending validates like booking (past date, same pickup/destination, seats)', async () => {
  const b = await make();
  const bad = await t.call('POST', `/bookings/${b.id}/amend`, {
    token: cust, body: { pickup: 'X', destination: 'x', pickupAt: inHours(-5), passengers: 9, sizeCode: 'saloon' },
  });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.fields.pickupAt && bad.body.error.fields.destination);
});

test('amending a booking with an assigned driver keeps the driver when still free, drops them when not', async () => {
  const b = await make();
  const { rows: drv } = await t.pool.query('SELECT id FROM drivers WHERE active ORDER BY full_name LIMIT 2');
  await t.pool.query("UPDATE bookings SET driver_id=$2, status='assigned' WHERE id=$1", [b.id, drv[0].id]);
  const r1 = await t.call('POST', `/bookings/${b.id}/amend`, { token: cust, body: { pickup: b.pickup, destination: b.destination, pickupAt: b.pickupAt, passengers: 3, sizeCode: 'saloon' } });
  assert.equal(r1.body.booking.status, 'assigned');
  assert.equal(r1.body.booking.driver.name.length > 0, true);

  const when = inHours(200);
  const blocker = await make({ pickupAt: when });
  await t.pool.query("UPDATE bookings SET driver_id=$2 WHERE id=$1", [blocker.id, drv[0].id]);
  const r2 = await t.call('POST', `/bookings/${b.id}/amend`, { token: cust, body: { pickup: b.pickup, destination: b.destination, pickupAt: when, passengers: 3, sizeCode: 'saloon' } });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.booking.status, 'confirmed');
  assert.equal(r2.body.booking.driver, null);
});
