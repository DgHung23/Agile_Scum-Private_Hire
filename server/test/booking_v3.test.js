import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let t;
let cust;
before(async () => {
  t = await startServer();
  cust = await t.login('customer@privatehire.test', 'Customer123!');
});
after(() => t.close());

const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const day = (n, h = 11) => {
  const d = new Date(Date.now() + n * 86400_000);
  d.setUTCHours(h, 0, 0, 0);
  return d.toISOString();
};
const CARD = { method: 'card', card: { number: '4242 4242 4242 4242', expMonth: 12, expYear: 2031, cvv: '123', holder: 'Alex Morgan' } };
const trip = (over = {}) => ({
  serviceCode: 'local', pickup: 'Camden Town', destination: 'Covent Garden', pickupAt: day(3), passengers: 2, sizeCode: 'saloon', payment: CARD, ...over,
});

test('N13 a Visitor gets a fare estimate without signing in', async () => {
  const q = await t.call('POST', '/bookings/quote', { body: { serviceCode: 'local', pickup: 'Camden Town', destination: 'Covent Garden', pickupAt: day(3), passengers: 1 } });
  assert.equal(q.status, 200);
  const saloon = q.body.sizes.find((s) => s.code === 'saloon');
  assert.ok(saloon.price.total > 0 && saloon.price.discountOnline > 0);
  assert.ok(saloon.price.lines.length >= 1, 'ID-32: the price breakdown is returned');
});

test('ID-29 pickup at least 30 minutes ahead, at most 90 days ahead, and different from the destination', async () => {
  const soon = await t.call('POST', '/bookings/quote', { body: { serviceCode: 'local', pickup: 'Camden Town', destination: 'Covent Garden', pickupAt: inHours(0.25), passengers: 1 } });
  assert.equal(soon.status, 400);
  assert.match(soon.body.error.fields.pickupAt, /30 minutes/);
  const far = await t.call('POST', '/bookings/quote', { body: { serviceCode: 'local', pickup: 'Camden Town', destination: 'Covent Garden', pickupAt: day(95), passengers: 1 } });
  assert.match(far.body.error.fields.pickupAt, /90 days/);
  const same = await t.call('POST', '/bookings/quote', { body: { serviceCode: 'local', pickup: 'Camden Town', destination: 'camden town', pickupAt: day(3), passengers: 1 } });
  assert.ok(same.body.error.fields.destination);
});

test('ID-40 "as soon as possible" books the earliest allowed time', async () => {
  const q = await t.call('POST', '/bookings/quote', { body: { serviceCode: 'local', pickup: 'Camden Town', destination: 'Covent Garden', asap: true, passengers: 1 } });
  assert.equal(q.status, 200);
  const mins = (new Date(q.body.pickupAt).getTime() - Date.now()) / 60000;
  assert.ok(mins >= 29 && mins <= 36, `pickup in ${mins} minutes`);
});

test('ID-30 passengers 1 to 8, luggage must fit the size, child seats and pet', async () => {
  const nine = await t.call('POST', '/bookings/quote', { body: { serviceCode: 'local', pickup: 'Camden Town', destination: 'Covent Garden', pickupAt: day(3), passengers: 9 } });
  assert.equal(nine.status, 400);
  const q = await t.call('POST', '/bookings/quote', { body: { serviceCode: 'local', pickup: 'Camden Town', destination: 'Covent Garden', pickupAt: day(3), passengers: 2, luggage: 4 } });
  const s = Object.fromEntries(q.body.sizes.map((x) => [x.code, x]));
  assert.equal(s.saloon.fits, false, 'a saloon takes 2 bags');
  assert.match(s.saloon.misfit, /bags/);
  assert.equal(s.estate.fits, true);
  const tooSmall = await t.book(cust, trip({ luggage: 4 }));
  assert.equal(tooSmall.status, 400);
  assert.ok(tooSmall.body.error.fields.luggage);
  const kids = await t.book(cust, trip({ passengers: 3, childSeatAges: [2, 6], pet: true, sizeCode: 'estate', pickupAt: day(3, 9) }));
  assert.equal(kids.status, 201, JSON.stringify(kids.body));
  assert.deepEqual(kids.body.booking.childSeatAges, [2, 6]);
  assert.equal(kids.body.booking.pet, true);
  const allKids = await t.book(cust, trip({ passengers: 2, childSeatAges: [2, 6], pickupAt: day(3, 10) }));
  assert.equal(allKids.status, 400, 'an adult must travel too');
});

test('ID-39 accessibility: a wheelchair request gets a wheelchair-accessible cab at no extra charge', async () => {
  const body = { serviceCode: 'local', pickup: 'Camden Town', destination: 'Covent Garden', pickupAt: day(4), passengers: 2 };
  const plain = await t.call('POST', '/bookings/quote', { body });
  const wheel = await t.call('POST', '/bookings/quote', { body: { ...body, accessibility: ['wheelchair', 'assistance_dog'] } });
  const p = (r, code) => r.body.sizes.find((s) => s.code === code);
  assert.equal(p(wheel, 'saloon').available, 0, 'no accessible saloons in the fleet');
  assert.ok(p(wheel, 'mpv7').available > 0);
  assert.equal(p(wheel, 'mpv7').price.total, p(plain, 'mpv7').price.total, 'no extra charge (Equality Act)');
  const r = await t.book(cust, trip({ ...body, sizeCode: 'mpv7', accessibility: ['wheelchair', 'help_find_car'] }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const cab = (await t.pool.query('SELECT c.wheelchair_accessible FROM bookings b JOIN cabs c ON c.id=b.cab_id WHERE b.id=$1', [r.body.booking.id])).rows[0];
  assert.equal(cab.wheelchair_accessible, true);
  const mail = (await t.pool.query("SELECT body FROM notifications WHERE kind='booking_confirmed' AND booking_id=$1", [r.body.booking.id])).rows[0];
  assert.match(mail.body, /Wheelchair-accessible vehicle \(no extra charge\)/);
});

test('ID-32 the terms and cancellation policy must be accepted before paying', async () => {
  const r = await t.call('POST', '/bookings', { token: cust, body: trip({ pickupAt: day(5) }) });
  assert.equal(r.status, 400);
  assert.ok(r.body.error.fields.acceptTerms);
});

test('ID-38 booking for another passenger: their phone gets the texts', async () => {
  const bad = await t.book(cust, trip({ passengerName: 'Mum', pickupAt: day(5, 9) }));
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.fields.passengerPhone);
  const r = await t.book(cust, trip({ passengerName: 'Margaret Morgan', passengerPhone: '07700 900999', notifyPref: 'both', pickupAt: day(5, 10) }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.booking.passenger, { name: 'Margaret Morgan', phone: '07700 900999' });
  assert.equal(r.body.booking.notifyPhone, '07700 900999');
});

test('ID-41 flight number for an airport pickup; N15 note to the driver', async () => {
  const bad = await t.book(cust, trip({ serviceCode: 'airport', pickup: 'Heathrow Airport (Terminal 5)', destination: 'Westminster', flightNo: 'not a flight', pickupAt: day(6) }));
  assert.ok(bad.body.error.fields.flightNo);
  const r = await t.book(cust, trip({ serviceCode: 'airport', pickup: 'Heathrow Airport (Terminal 5)', destination: 'Westminster', flightNo: 'ba 117', noteToDriver: 'Two large cases', pickupAt: day(6, 12) }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.booking.flightNo, 'BA 117');
  assert.equal(r.body.booking.noteToDriver, 'Two large cases');
});

test('ID-75 daily hire is booked as a package', async () => {
  const pk = await t.call('GET', '/catalog/packages');
  assert.deepEqual(pk.body.packages.map((p) => p.code), ['half_day', 'full_day', 'long_day']);
  const none = await t.book(cust, trip({ serviceCode: 'daily_hire', destination: '', pickupAt: day(7) }));
  assert.ok(none.body.error.fields.packageCode);
  const r = await t.book(cust, trip({ serviceCode: 'daily_hire', destination: '', packageCode: 'full_day', pickupAt: day(7) }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.booking.hours, 8);
  assert.equal(r.body.booking.package.code, 'full_day');
});

test('N16 a return journey is a second, linked booking; one payment covers both', async () => {
  const bad = await t.book(cust, trip({ pickupAt: day(8, 10), returnAt: day(8, 9) }));
  assert.ok(bad.body.error.fields.returnAt, 'the return must be after the outward journey');
  const q = await t.call('POST', '/bookings/quote', { body: { serviceCode: 'local', pickup: 'Camden Town', destination: 'Covent Garden', pickupAt: day(8, 10), returnAt: day(8, 17), passengers: 2 } });
  assert.ok(q.body.sizes[0].returnPrice.total > 0);
  const r = await t.book(cust, trip({ pickupAt: day(8, 10), returnAt: day(8, 17) }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.bookings.length, 2);
  const [out, back] = r.body.bookings;
  assert.equal(back.pickup, out.destination);
  assert.equal(back.destination, out.pickup);
  assert.equal(back.returnOf, out.id);
  assert.ok(r.body.bookings.every((b) => b.status === 'confirmed' && b.paymentStatus === 'paid'));
  const pays = (await t.pool.query("SELECT count(*)::int AS n FROM payments WHERE booking_id = ANY($1) AND status='approved'", [[out.id, back.id]])).rows[0].n;
  assert.equal(pays, 2, 'one approved charge per booking');
  const detail = await t.call('GET', `/bookings/${out.id}`, { token: cust });
  assert.equal(detail.body.linked[0].id, back.id);
});

test('ID-63 online amendments cannot move a booking into the next 24 hours', async () => {
  const r = await t.book(cust, trip({ pickupAt: day(9) }));
  const b = r.body.booking;
  const am = await t.call('POST', `/bookings/${b.id}/amend`, { token: cust, body: { pickup: b.pickup, destination: b.destination, pickupAt: inHours(5), passengers: 2, sizeCode: 'saloon' } });
  assert.equal(am.status, 400);
  assert.match(am.body.error.fields.pickupAt, /more than 24 hours/);
});

test('ID-52 night and central-zone surcharges appear in the price lines', async () => {
  const night = new Date(Date.now() + 3 * 86400_000);
  night.setUTCHours(23, 30, 0, 0);
  const q = await t.call('POST', '/bookings/quote', { body: { serviceCode: 'local', pickup: 'Covent Garden', destination: 'Camden Town', pickupAt: night.toISOString(), passengers: 1 } });
  const lines = q.body.sizes[0].price.lines.map((l) => l.label).join(' | ');
  assert.match(lines, /Night surcharge/);
  assert.match(lines, /Central London zone/);
  assert.equal(q.body.night, true);
});

test('ID-76, ID-52 the Manager manages prices and surcharges; staff cannot; changes are audited', async () => {
  const staff = await t.login('staff@privatehire.test', 'StaffPass123!', true);
  const mgr = await t.login('manager@privatehire.test', 'ManagerPass123!', true);
  assert.equal((await t.call('GET', '/staff/pricing', { token: staff })).status, 403);
  const p = await t.call('GET', '/staff/pricing', { token: mgr });
  assert.equal(p.status, 200);
  assert.equal(p.body.services.length, 6);
  const body = { serviceCode: 'local', pickup: 'Camden Town', destination: 'Brixton', pickupAt: day(10, 12), passengers: 1 };
  const before = (await t.call('POST', '/bookings/quote', { body })).body.sizes[0].price;
  const bad = await t.call('PUT', '/staff/pricing', { token: mgr, body: { surcharges: { weather_surcharge_pct: 500 } } });
  assert.equal(bad.status, 400);
  const ok = await t.call('PUT', '/staff/pricing', { token: mgr, body: { surcharges: { weather_surcharge_pct: 10 }, services: [{ code: 'local', perMile: 3 }] } });
  assert.equal(ok.status, 200);
  const after = (await t.call('POST', '/bookings/quote', { body })).body.sizes[0].price;
  assert.ok(after.full > before.full);
  assert.match(after.lines.map((l) => l.label).join(), /Bad weather surcharge \(10%\)/);
  const log = (await t.pool.query("SELECT action FROM audit_log WHERE action LIKE 'pricing.%'")).rows.map((r) => r.action);
  assert.ok(log.includes('pricing.surcharge') && log.includes('pricing.service'));
  await t.call('PUT', '/staff/pricing', { token: mgr, body: { surcharges: { weather_surcharge_pct: 0 }, services: [{ code: 'local', perMile: 2.2 }] } });
});
