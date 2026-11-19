import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let t;
let cust;
let staff;
let manager;
let driverTok;
let myDriverId;
before(async () => {
  t = await startServer();
  cust = await t.login('customer@privatehire.test', 'Customer123!');
  staff = await t.login('staff@privatehire.test', 'StaffPass123!', true);
  manager = await t.login('manager@privatehire.test', 'ManagerPass123!', true);
  driverTok = await t.login('driver@privatehire.test', 'DriverPass123!', true);
  myDriverId = (await t.pool.query("SELECT id FROM drivers WHERE licence_no='PHD-10001'")).rows[0].id;
});
after(() => t.close());

const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const CARD = { method: 'card', card: { number: '4242 4242 4242 4242', expMonth: 12, expYear: 2031, cvv: '123', holder: 'Alex Morgan' } };
const book = async (over = {}) => {
  const r = await t.book(cust, { serviceCode: 'local', pickup: 'Camden Town', destination: 'Brixton', pickupAt: inHours(30), passengers: 2, sizeCode: 'saloon', notifyPref: 'both', payment: CARD, ...over });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.booking;
};
const assign = (b, driverId = myDriverId, cabId) => t.call('POST', `/staff/bookings/${b.id}/assign`, { token: staff, body: { driverId, ...(cabId ? { cabId } : {}) } });
const status = (b, body, token = staff) => t.call('POST', `/staff/bookings/${b.id}/status`, { token, body });

test('ID-65, ID-66 an expired document stops a driver being assigned; the Manager renews it', async () => {
  const b = await book({ pickupAt: inHours(40) });
  const other = (await t.pool.query("SELECT id FROM drivers WHERE licence_no='PHD-10002'")).rows[0].id;
  await t.pool.query("UPDATE documents SET expires_on = current_date - 1 WHERE owner_id=$1 AND doc_type='phv_driver_licence'", [other]);
  const opts = await t.call('GET', `/staff/bookings/${b.id}/options`, { token: staff });
  assert.ok(!opts.body.drivers.some((d) => d.id === other), 'not offered');
  assert.equal((await assign(b, other)).status, 409);
  const exp = await t.call('GET', '/staff/documents/expiring', { token: manager });
  assert.ok(exp.body.documents.some((d) => d.ownerId === other && d.expired));
  const renew = { docType: 'phv_driver_licence', reference: 'PHV-NEW', expiresOn: new Date(Date.now() + 300 * 86400_000).toISOString().slice(0, 10) };
  assert.equal((await t.call('PUT', `/staff/drivers/${other}/documents`, { token: staff, body: renew })).status, 403, 'only the Manager');
  const ok = await t.call('PUT', `/staff/drivers/${other}/documents`, { token: manager, body: renew });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.documents.every((d) => !d.expired));
  assert.equal((await assign(b, other)).status, 200);
  const drivers = await t.call('GET', '/staff/drivers', { token: staff });
  assert.ok(drivers.body.drivers[0].documents.length === 2);
});

let job;
test('N34, N35 the driver sees only their jobs and moves them on: on my way, arrived, picked up, completed', async () => {
  job = await book();
  assert.equal((await assign(job)).status, 200);
  const list = await t.call('GET', '/driver/jobs', { token: driverTok });
  assert.equal(list.status, 200);
  const mine = list.body.jobs.find((j) => j.id === job.id);
  assert.ok(mine);
  assert.equal(mine.passengerFirstName, 'Alex');
  assert.equal(mine.customerEmail, undefined, 'job details only');
  assert.equal((await t.call('GET', '/driver/jobs', { token: staff })).status, 403);

  const skip = await t.call('POST', `/driver/jobs/${job.id}/status`, { token: driverTok, body: { status: 'completed' } });
  assert.equal(skip.status, 409, 'drivers cannot skip steps');
  assert.equal((await t.call('POST', `/driver/jobs/${job.id}/status`, { token: driverTok, body: { status: 'on_route', etaMinutes: 10 } })).status, 200);
  assert.equal((await t.pool.query("SELECT 1 FROM notifications WHERE kind='driver_near' AND booking_id=$1", [job.id])).rowCount, 1);
  const arrived = await t.call('POST', `/driver/jobs/${job.id}/status`, { token: driverTok, body: { status: 'arrived' } });
  assert.equal(arrived.body.job.status, 'arrived');
  assert.equal((await t.pool.query("SELECT 1 FROM notifications WHERE kind='driver_arrived' AND booking_id=$1", [job.id])).rowCount >= 1, true);
  const early = await t.call('POST', `/driver/jobs/${job.id}/status`, { token: driverTok, body: { status: 'no_show' } });
  assert.equal(early.status, 409, 'N18: 10 minutes of free waiting first');
  assert.equal((await t.call('POST', `/driver/jobs/${job.id}/status`, { token: driverTok, body: { status: 'in_progress' } })).status, 200);
  const done = await t.call('POST', `/driver/jobs/${job.id}/status`, { token: driverTok, body: { status: 'completed' } });
  assert.equal(done.body.job.status, 'completed');
  const hist = await t.call('GET', `/staff/bookings/${job.id}/history`, { token: staff });
  assert.deepEqual(hist.body.events.map((e) => e.status).slice(-5), ['assigned', 'on_route', 'arrived', 'in_progress', 'completed']);
  assert.equal(hist.body.events.at(-1).role, 'driver');
  assert.equal(hist.body.assignments[0].dispatchedBy, 'Sam Carter', 'TfL: who dispatched the car');
});

test('ID-56 a cash booking needs the cash collected before completing; then the receipt is issued', async () => {
  const b = await book({ pickupAt: inHours(50), payment: { method: 'cash' } });
  await assign(b);
  for (const s of [{ status: 'on_route', etaMinutes: 20 }, { status: 'arrived' }, { status: 'in_progress' }]) {
    await t.call('POST', `/driver/jobs/${b.id}/status`, { token: driverTok, body: s });
  }
  const noCash = await t.call('POST', `/driver/jobs/${b.id}/status`, { token: driverTok, body: { status: 'completed' } });
  assert.equal(noCash.status, 400);
  const ok = await t.call('POST', `/driver/jobs/${b.id}/status`, { token: driverTok, body: { status: 'completed', cashCollected: true } });
  assert.equal(ok.status, 200);
  const r = await t.pool.query("SELECT r.number FROM receipts r WHERE r.booking_id=$1", [b.id]);
  assert.equal(r.rowCount, 1);
});

test('N18 no-show only after 10 minutes of free waiting; the customer is told', async () => {
  const b = await book({ pickupAt: inHours(60) });
  await assign(b);
  await status(b, { status: 'on_route', etaMinutes: 5 });
  await status(b, { status: 'arrived' });
  assert.equal((await status(b, { status: 'no_show' })).status, 409);
  await t.pool.query("UPDATE bookings SET arrived_at = now() - interval '11 minutes' WHERE id=$1", [b.id]);
  const r = await status(b, { status: 'no_show' });
  assert.equal(r.status, 200);
  assert.equal(r.body.booking.status, 'no_show');
  assert.equal((await t.pool.query("SELECT 1 FROM notifications WHERE kind='no_show' AND booking_id=$1", [b.id])).rowCount, 1);
});

test('N30, N36 a breakdown interrupts the journey; staff send a same-size car; the fare does not rise', async () => {
  const b = await book({ pickupAt: inHours(70) });
  await assign(b);
  await t.call('POST', `/driver/jobs/${b.id}/status`, { token: driverTok, body: { status: 'on_route', etaMinutes: 30 } });
  const rep = await t.call('POST', `/driver/jobs/${b.id}/report`, { token: driverTok, body: { kind: 'breakdown', message: 'Flat tyre on the A40' } });
  assert.equal(rep.status, 201);
  assert.equal(rep.body.job.status, 'interrupted');
  const brokenCab = (await t.pool.query('SELECT cab_id FROM bookings WHERE id=$1', [b.id])).rows[0].cab_id;
  assert.equal((await t.pool.query('SELECT status FROM cabs WHERE id=$1', [brokenCab])).rows[0].status, 'unavailable', 'broken car is Unavailable');
  const opts = await t.call('GET', `/staff/bookings/${b.id}/options`, { token: staff });
  const cab = opts.body.cabs.find((c) => c.sizeCode === 'saloon' && c.id !== brokenCab);
  const other = opts.body.drivers.find((d) => d.id !== myDriverId);
  const before = (await t.pool.query('SELECT total FROM bookings WHERE id=$1', [b.id])).rows[0].total;
  const rep2 = await assign(b, other.id, cab.id);
  assert.equal(rep2.status, 200, JSON.stringify(rep2.body));
  assert.equal(rep2.body.booking.status, 'assigned');
  assert.equal((await t.pool.query('SELECT total FROM bookings WHERE id=$1', [b.id])).rows[0].total, before);
  const sms = (await t.pool.query("SELECT body FROM notifications WHERE kind='replacement_car' AND booking_id=$1 AND channel='sms'", [b.id])).rows[0];
  assert.ok(sms.body.includes(cab.reg));
  const hist = await t.call('GET', `/staff/bookings/${b.id}/history`, { token: staff });
  assert.equal(hist.body.assignments.length, 2);
  assert.equal(hist.body.assignments[0].endReason, 'replaced after interruption');
  // the Manager clears the car
  assert.equal((await t.call('PATCH', `/staff/cabs/${brokenCab}/status`, { token: manager, body: { status: 'available' } })).status, 200);
});

test('ID-45 a driver more than 15 minutes late: a text, and the customer may cancel free even inside 24 hours', async () => {
  const b = await book({ pickupAt: inHours(3) });
  await assign(b);
  assert.equal((await t.call('POST', `/bookings/${b.id}/cancel`, { token: cust, body: {} })).status, 409, 'inside 24 hours');
  await t.call('POST', `/driver/jobs/${b.id}/late`, { token: driverTok, body: { minutes: 25 } });
  const sms = (await t.pool.query("SELECT body FROM notifications WHERE kind='driver_late' AND booking_id=$1 AND channel='sms'", [b.id])).rows[0];
  assert.match(sms.body, /25 minutes late.*cancel free/);
  const c = await t.call('POST', `/bookings/${b.id}/cancel`, { token: cust, body: {} });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.refund.amount, b.price.total, 'full refund');
});

test('N27 staff refund up to GBP 50 per booking per day; the Manager can refund more; credit notes are created', async () => {
  const b = await book({ pickupAt: inHours(80), serviceCode: 'long_distance', destination: 'Oxford' });
  assert.ok(b.price.total > 70, `total ${b.price.total}`);
  const noReason = await t.call('POST', `/staff/bookings/${b.id}/refund`, { token: staff, body: { amount: 10 } });
  assert.equal(noReason.status, 400);
  assert.equal((await t.call('POST', `/staff/bookings/${b.id}/refund`, { token: staff, body: { amount: 30, reason: 'Driver late' } })).status, 200);
  const split = await t.call('POST', `/staff/bookings/${b.id}/refund`, { token: staff, body: { amount: 30, reason: 'More goodwill' } });
  assert.equal(split.status, 403, 'red-team row 9: cannot split a big refund');
  assert.equal(split.body.error.code, 'over_refund_limit');
  const mgr = await t.call('POST', `/staff/bookings/${b.id}/refund`, { token: manager, body: { amount: 30, reason: 'Manager approved' } });
  assert.equal(mgr.status, 200);
  assert.equal(mgr.body.booking.paymentStatus, 'partially_refunded');
  const cn = await t.pool.query("SELECT count(*)::int AS n FROM receipts WHERE booking_id=$1 AND kind='credit_note'", [b.id]);
  assert.equal(cn.rows[0].n, 2);
  const mail = (await t.pool.query("SELECT body FROM notifications WHERE kind='refund' AND booking_id=$1 LIMIT 1", [b.id])).rows[0];
  assert.match(mail.body, /3 to 5 working days/);
  assert.ok((await t.pool.query("SELECT 1 FROM audit_log WHERE action='refund.create' AND target_id=$1", [b.id])).rowCount >= 2);
});

test('N31 a cleaning charge goes on the original card with a reason the customer can dispute', async () => {
  const b = await book({ pickupAt: inHours(90) });
  const r = await t.call('POST', `/staff/bookings/${b.id}/charge`, { token: staff, body: { amount: 40, kind: 'cleaning', reason: 'Spilled drink on the back seat' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = (await t.pool.query("SELECT * FROM payments WHERE booking_id=$1 AND charge_kind='cleaning'", [b.id])).rows[0];
  assert.equal(p.card_last4, '4242');
  assert.equal(p.reason, 'Spilled drink on the back seat');
  const mail = (await t.pool.query("SELECT body FROM notifications WHERE kind='extra_charge' AND booking_id=$1", [b.id])).rows[0];
  assert.match(mail.body, /If you disagree/);
});

test('N26 change of destination during the journey reprices it and settles the difference', async () => {
  const b = await book({ pickupAt: inHours(100) });
  await assign(b);
  await status(b, { status: 'on_route', etaMinutes: 20 });
  assert.equal((await t.call('POST', `/staff/bookings/${b.id}/destination`, { token: staff, body: { destination: 'Camden Town' } })).status, 400, 'same as pickup');
  const r = await t.call('POST', `/staff/bookings/${b.id}/destination`, { token: staff, body: { destination: 'Heathrow Airport (Terminal 5)' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.booking.destination, 'Heathrow Airport (Terminal 5)');
  assert.ok(r.body.difference > 0);
  assert.ok((await t.pool.query("SELECT 1 FROM payments WHERE booking_id=$1 AND charge_kind='difference'", [b.id])).rowCount === 1);
});

test('ID-78 the company cancels only after offering another time or size; full refund and apology', async () => {
  const b = await book({ pickupAt: inHours(110) });
  const alt = await t.call('GET', `/staff/bookings/${b.id}/alternatives`, { token: staff });
  assert.equal(alt.status, 200);
  assert.ok(Array.isArray(alt.body.alternatives.times));
  const noOffer = await t.call('POST', `/staff/bookings/${b.id}/company-cancel`, { token: staff, body: { reason: 'No cab after breakdowns' } });
  assert.equal(noOffer.status, 400);
  const ok = await t.call('POST', `/staff/bookings/${b.id}/company-cancel`, { token: staff, body: { reason: 'No cab after breakdowns', alternativesOffered: true } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.booking.status, 'company_cancelled');
  assert.equal(ok.body.refund.amount, b.price.total);
  const mail = (await t.pool.query("SELECT body FROM notifications WHERE kind='booking_cancelled' AND booking_id=$1", [b.id])).rows[0];
  assert.match(mail.body, /very sorry/);
});

test('ID-77, N18 staff cancel for a caller with a reason; inside 24 hours they may keep the late-cancellation fee', async () => {
  const b = await book({ pickupAt: inHours(5) });
  const r = await t.call('POST', `/staff/bookings/${b.id}/cancel`, { token: staff, body: { reason: 'Caller changed plans', lateFee: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.refund.amount, Math.round(b.price.total * 50) / 100);
  assert.equal(r.body.booking.paymentStatus, 'partially_refunded');
  assert.ok((await t.pool.query("SELECT 1 FROM audit_log WHERE action='booking.cancel' AND target_id=$1", [b.id])).rowCount === 1);
});
