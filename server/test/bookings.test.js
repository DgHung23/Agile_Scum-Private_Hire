import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let t;
let cust;
let staff;
before(async () => {
  t = await startServer();
  cust = await t.login('customer@privatehire.test', 'Customer123!');
  staff = await t.login('staff@privatehire.test', 'Staff123!', true);
});
after(() => t.close());

const day = (n, h = 10, m = 0) => {
  const d = new Date(Date.now() + n * 24 * 3600_000);
  d.setUTCHours(h, m, 0, 0);
  return d.toISOString();
};

const journey = (over = {}) => ({
  serviceCode: 'local',
  pickup: 'Paddington Station',
  destination: 'Canary Wharf',
  pickupAt: day(3),
  passengers: 2,
  sizeCode: 'saloon',
  notifyPref: 'email',
  ...over,
});

test('US5.2 quote is public and prices every cab size with the 15% online discount', async () => {
  const { sizeCode, notifyPref, ...q } = journey({ passengers: 5 });
  const r = await t.call('POST', '/bookings/quote', { body: q });
  assert.equal(r.status, 200);
  assert.equal(r.body.sizes.length, 5);
  assert.equal(r.body.onlineDiscountPct, 15);
  const saloon = r.body.sizes.find((s) => s.code === 'saloon');
  assert.equal(saloon.fitsPassengers, false, '5 passengers do not fit a 4-seater');
  assert.equal(r.body.sizes.find((s) => s.code === 'mpv6').fitsPassengers, true);
  assert.equal(saloon.price.discountOnline, Math.round(saloon.price.full * 15) / 100);
  assert.equal(saloon.available, 12);
});

test('R3 staff quoting for the phone channel gets no online discount', async () => {
  const { sizeCode, notifyPref, ...q } = journey();
  const r = await t.call('POST', '/bookings/quote', { token: staff, body: { ...q, channel: 'phone' } });
  assert.equal(r.body.sizes[0].price.discountOnline, 0);
  // a customer cannot ask for the phone channel to dodge the rule in the other direction
  const c = await t.call('POST', '/bookings/quote', { token: cust, body: { ...q, channel: 'phone' } });
  assert.equal(c.body.channel, 'online');
});

test('US3.2 validation: required fields, past dates, same pickup and destination', async () => {
  const empty = await t.call('POST', '/bookings/quote', { body: { serviceCode: 'local', passengers: 1, pickupAt: day(3) } });
  assert.equal(empty.status, 400);
  assert.ok(empty.body.error.fields.pickup && empty.body.error.fields.destination);

  const past = await t.call('POST', '/bookings/quote', { body: journey({ pickupAt: day(-1) }) });
  assert.ok(past.body.error.fields.pickupAt);

  const same = await t.call('POST', '/bookings/quote', { body: journey({ pickup: 'Camden Town', destination: 'camden town' }) });
  assert.ok(same.body.error.fields.destination);

  const noService = await t.call('POST', '/bookings/quote', { body: journey({ serviceCode: 'teleport' }) });
  assert.ok(noService.body.error.fields.serviceCode);
});

test('US3.1 airport services need an airport at one end; daily hire needs valid hours', async () => {
  const bad = await t.call('POST', '/bookings/quote', { body: journey({ serviceCode: 'airport' }) });
  assert.ok(bad.body.error.fields.destination);
  const good = await t.call('POST', '/bookings/quote', { body: journey({ serviceCode: 'airport', destination: 'Heathrow Airport (Terminal 5)' }) });
  assert.equal(good.status, 200);
  const hrs = await t.call('POST', '/bookings/quote', { body: journey({ serviceCode: 'daily_hire', destination: '', hours: 2 }) });
  assert.ok(hrs.body.error.fields.hours);
  const ok = await t.call('POST', '/bookings/quote', { body: journey({ serviceCode: 'daily_hire', destination: '', hours: 6 }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sizes[0].price.full, 168);
});

test('US3.5 booking requires a customer login', async () => {
  assert.equal((await t.call('POST', '/bookings', { body: journey() })).status, 401);
  assert.equal((await t.call('POST', '/bookings', { token: staff, body: journey() })).status, 403);
});

test('US3.3 too many passengers for the chosen cab is rejected', async () => {
  const r = await t.call('POST', '/bookings', { token: cust, body: journey({ passengers: 6, sizeCode: 'estate' }) });
  assert.equal(r.status, 400);
  assert.ok(r.body.error.fields.passengers);
});

let first;
test('US3.5 / US3.4 / US3.7 / US4.2 confirm a booking: reference, 15% off, priority, email', async () => {
  const r = await t.call('POST', '/bookings', { token: cust, body: journey({ notifyPref: 'both' }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  first = r.body.booking;
  assert.match(first.ref, /^PH-[A-Z0-9]{6}$/);
  assert.equal(first.status, 'confirmed');
  assert.equal(first.channel, 'online');
  assert.equal(first.priority, true);
  assert.equal(first.price.discountOnline, Math.round(first.price.full * 15) / 100);
  assert.equal(first.price.total, Math.round((first.price.full - first.price.discountOnline) * 100) / 100);
  assert.equal(first.notifyPhone, '07700 900123', 'text updates use the profile phone number');
  assert.equal(first.vehicle, null, 'vehicle details are only revealed once a driver is assigned');
  assert.equal(first.modifiable, true);
  const mail = await t.pool.query("SELECT * FROM notifications WHERE kind='booking_confirmed' AND booking_id=$1", [first.id]);
  assert.equal(mail.rowCount, 1);
  assert.ok(mail.rows[0].body.includes(first.ref) && mail.rows[0].body.includes('Paddington Station'));
});

test('US3.6 my bookings: upcoming list and ownership', async () => {
  const up = await t.call('GET', '/bookings?when=upcoming', { token: cust });
  assert.ok(up.body.bookings.find((b) => b.id === first.id));
  const past = await t.call('GET', '/bookings?when=past', { token: cust });
  assert.ok(!past.body.bookings.find((b) => b.id === first.id));

  const other = await t.call('POST', '/auth/register', {
    body: { fullName: 'Pat Other', email: 'pat@example.com', phone: '07700 900321', addressLine: '2 Road', city: 'London', postcode: 'N1 9GU', password: 'Passw0rd1' },
  });
  assert.equal(other.status, 201);
  const otherTok = await t.login('pat@example.com', 'Passw0rd1');
  assert.equal((await t.call('GET', `/bookings/${first.id}`, { token: otherTok })).status, 404);
  assert.equal((await t.call('GET', `/bookings/${first.id}`, { token: cust })).status, 200);
  assert.equal((await t.call('GET', '/bookings/not-a-uuid', { token: cust })).status, 404);
});

test('US5.1 when every cab of a size is taken the customer gets alternatives', async () => {
  const when = day(8, 15);
  const body = () => journey({ pickupAt: when, sizeCode: 'minibus', passengers: 7, pickup: 'Wembley Stadium', destination: 'Heathrow Airport (Terminal 2)', serviceCode: 'airport' });
  for (let i = 0; i < 3; i++) {
    const ok = await t.call('POST', '/bookings', { token: cust, body: body(i) });
    assert.equal(ok.status, 201, `minibus ${i + 1} of 3 should be available`);
  }
  const full = await t.call('POST', '/bookings', { token: cust, body: body(3) });
  assert.equal(full.status, 409);
  assert.equal(full.body.error.code, 'no_availability');
  assert.ok(full.body.error.alternatives.sizes.some((s) => s.code === 'mpv7'), 'offers a seven-seater instead');
  assert.ok(full.body.error.alternatives.times.length > 0, 'offers other times');
  const quote = await t.call('POST', '/bookings/quote', { body: { ...body(3), sizeCode: undefined } });
  assert.equal(quote.body.sizes.find((s) => s.code === 'minibus').available, 0);
  // all three minibuses are different cabs
  const cabs = await t.pool.query("SELECT DISTINCT cab_id FROM bookings WHERE size_code='minibus'");
  assert.equal(cabs.rowCount, 3);
});

test('US5.1 parallel requests never double-book a cab', async () => {
  const when = day(9, 9);
  const reqs = Array.from({ length: 6 }, () =>
    t.call('POST', '/bookings', { token: cust, body: journey({ pickupAt: when, sizeCode: 'mpv6', passengers: 5 }) }),
  );
  const res = await Promise.all(reqs);
  const created = res.filter((r) => r.status === 201).length;
  assert.equal(created, 4, 'only 4 six-seaters exist');
  assert.equal(res.filter((r) => r.status === 409).length, 2);
  const dup = await t.pool.query(
    "SELECT cab_id, count(*) FROM bookings WHERE size_code='mpv6' AND status<>'cancelled' GROUP BY cab_id HAVING count(*)>1",
  );
  assert.equal(dup.rowCount, 0);
});
