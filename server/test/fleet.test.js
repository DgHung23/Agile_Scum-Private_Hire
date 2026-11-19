import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { bookingWindow, findAvailableCabs, BUFFER_MINUTES } from '../src/services/availability.js';

let t;
let staff;
before(async () => {
  t = await startServer();
  staff = await t.login('staff@privatehire.test', 'Staff123!', true);
});
after(() => t.close());

const cab = { reg: 'zz99 abc', make: 'Toyota', model: 'Prius', colour: 'Black', sizeCode: 'saloon' };

test('reference data: services, sizes and places are public', async () => {
  const s = await t.call('GET', '/catalog/services');
  assert.equal(s.body.services.length, 6);
  assert.ok(s.body.services.find((x) => x.code === 'daily_hire').isHourly);
  const z = await t.call('GET', '/catalog/cab-sizes');
  assert.ok(z.body.cabSizes.find((x) => x.seats === 7));
  const l = await t.call('GET', '/catalog/locations?q=heath');
  assert.ok(l.body.locations.every((x) => /heath/i.test(x.name)));
});

test('US9.6 fleet endpoints are staff only', async () => {
  assert.equal((await t.call('GET', '/staff/cabs')).status, 401);
  const cust = await t.login('customer@privatehire.test', 'Customer123!');
  assert.equal((await t.call('GET', '/staff/cabs', { token: cust })).status, 403);
  assert.equal((await t.call('GET', '/staff/cabs', { token: staff })).status, 200);
});

test('US9.6 add cab: validated and registration unique ignoring case/spaces', async () => {
  const bad = await t.call('POST', '/staff/cabs', { token: staff, body: { reg: '', make: '', model: '', colour: '', sizeCode: '' } });
  assert.equal(bad.status, 400);
  const ok = await t.call('POST', '/staff/cabs', { token: staff, body: cab });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.cab.reg, 'ZZ99 ABC');
  const dup = await t.call('POST', '/staff/cabs', { token: staff, body: { ...cab, reg: 'ZZ99ABC' } });
  assert.equal(dup.status, 409);
  assert.ok(dup.body.error.fields.reg);
  const badSize = await t.call('POST', '/staff/cabs', { token: staff, body: { ...cab, reg: 'QQ11 AAA', sizeCode: 'tank' } });
  assert.equal(badSize.status, 400);
});

test('US9.6 edit and deactivate a cab', async () => {
  const list = await t.call('GET', '/staff/cabs?q=ZZ99', { token: staff });
  const id = list.body.cabs[0].id;
  const edit = await t.call('PATCH', `/staff/cabs/${id}`, { token: staff, body: { ...cab, colour: 'Blue', active: false } });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.cab.colour, 'Blue');
  assert.equal(edit.body.cab.active, false);
  assert.equal((await t.call('GET', '/staff/cabs?active=true&q=ZZ99', { token: staff })).body.cabs.length, 0);
});

test('US9.7 drivers: add, unique licence, deactivate', async () => {
  const d = { fullName: 'Test Driver', phone: '07700 900999', licenceNo: 'phd-99999' };
  const ok = await t.call('POST', '/staff/drivers', { token: staff, body: d });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.driver.licenceNo, 'PHD-99999');
  const dup = await t.call('POST', '/staff/drivers', { token: staff, body: d });
  assert.equal(dup.status, 409);
  const off = await t.call('PATCH', `/staff/drivers/${ok.body.driver.id}`, { token: staff, body: { ...d, active: false } });
  assert.equal(off.body.driver.active, false);
  assert.equal((await t.call('POST', '/staff/drivers', { token: staff, body: { fullName: '', phone: 'x', licenceNo: '' } })).status, 400);
});

async function insertBooking({ cabId, driverId = null, start, minutes = 60, status = 'confirmed' }) {
  const { rows: cust } = await t.pool.query("SELECT id FROM users WHERE email='customer@privatehire.test'");
  const { start: s, end } = bookingWindow(start, minutes);
  return t.pool.query(
    `INSERT INTO bookings (ref, customer_id, service_code, pickup, destination, pickup_at, end_at, passengers, size_code, cab_id, driver_id,
                           status, price_full, total)
     VALUES ($1,$2,'local','A','B',$3,$4,2,'saloon',$5,$6,$7,20,20)`,
    ['PH-T' + Math.random().toString(36).slice(2, 8).toUpperCase(), cust[0].id, s, end, cabId, driverId, status],
  );
}

test('US5.1 availability: a booked cab is excluded for overlapping times only', async () => {
  const { rows: cabs } = await t.pool.query("SELECT id FROM cabs WHERE size_code='saloon' AND active ORDER BY reg LIMIT 1");
  const cabId = cabs[0].id;
  const start = new Date(Date.now() + 5 * 24 * 3600_000);
  await insertBooking({ cabId, start, minutes: 60 });

  const w1 = bookingWindow(new Date(start.getTime() + 30 * 60_000), 30); // overlaps
  const during = await findAvailableCabs(null, { ...w1, sizeCode: 'saloon' });
  assert.ok(!during.find((c) => c.id === cabId), 'booked cab must not be offered');

  const w2 = bookingWindow(new Date(start.getTime() + (60 + BUFFER_MINUTES + 5) * 60_000), 30); // after buffer
  const after = await findAvailableCabs(null, { ...w2, sizeCode: 'saloon' });
  assert.ok(after.find((c) => c.id === cabId), 'cab is free again after the journey and buffer');
});

test('US5.1 criterion 2: the database refuses to double-book a cab or a driver', async () => {
  const { rows: cabs } = await t.pool.query("SELECT id FROM cabs WHERE size_code='estate' AND active ORDER BY reg LIMIT 2");
  const { rows: drivers } = await t.pool.query('SELECT id FROM drivers WHERE active ORDER BY full_name LIMIT 1');
  const start = new Date(Date.now() + 6 * 24 * 3600_000);
  await insertBooking({ cabId: cabs[0].id, driverId: drivers[0].id, start });
  await assert.rejects(insertBooking({ cabId: cabs[0].id, start: new Date(start.getTime() + 10 * 60_000) }), (e) => e.code === '23P01');
  await assert.rejects(
    insertBooking({ cabId: cabs[1].id, driverId: drivers[0].id, start: new Date(start.getTime() + 10 * 60_000) }),
    (e) => e.code === '23P01',
  );
  // a cancelled booking frees the slot
  await t.pool.query("UPDATE bookings SET status='cancelled' WHERE cab_id=$1", [cabs[0].id]);
  await insertBooking({ cabId: cabs[0].id, start });
});

test('US9.6 cannot deactivate a cab that has upcoming bookings', async () => {
  const { rows } = await t.pool.query("SELECT c.id, c.reg, c.make, c.model, c.colour, c.size_code FROM cabs c JOIN bookings b ON b.cab_id=c.id WHERE b.status<>'cancelled' LIMIT 1");
  const c = rows[0];
  const r = await t.call('PATCH', `/staff/cabs/${c.id}`, {
    token: staff,
    body: { reg: c.reg, make: c.make, model: c.model, colour: c.colour, sizeCode: c.size_code, active: false },
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'has_bookings');
});

test('US9.4 staff availability lookup returns free cabs and drivers', async () => {
  const start = new Date(Date.now() + 10 * 24 * 3600_000).toISOString();
  const r = await t.call('GET', `/staff/availability?start=${encodeURIComponent(start)}&durationMinutes=45&size=mpv7`, { token: staff });
  assert.equal(r.status, 200);
  assert.ok(r.body.cabs.length > 0 && r.body.cabs.every((c) => c.sizeCode === 'mpv7'));
  assert.ok(r.body.drivers.length > 0);
  assert.equal((await t.call('GET', '/staff/availability?start=nope', { token: staff })).status, 400);
});
