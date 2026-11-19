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
const PAY = { method: 'card', card: { number: '4242 4242 4242 4242', expMonth: 12, expYear: 2031, cvv: '123', holder: 'Alex Morgan' } };
const book = async (over = {}) => {
  const r = await t.book(cust, { serviceCode: 'local', pickup: 'Brixton', destination: 'Shoreditch', pickupAt: inHours(72), passengers: 2, sizeCode: 'saloon', notifyPref: 'text', payment: PAY, ...over });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.booking;
};

/* ---------------- enquiries ---------------- */

test('US2.1 anyone can send a general enquiry; validation and acknowledgement email', async () => {
  const bad = await t.call('POST', '/enquiries', { body: { name: '', email: 'nope', subject: '', message: '' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.fields.name && bad.body.error.fields.email && bad.body.error.fields.subject && bad.body.error.fields.message);
  const ok = await t.call('POST', '/enquiries', { body: { name: 'Visitor Vic', email: 'vic@example.com', subject: 'Do you cover Kent?', message: 'We need a cab to Canterbury weekly.' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.enquiry.status, 'new');
  assert.match(ok.body.enquiry.ref, /^EN-/);
  assert.equal((await t.pool.query("SELECT 1 FROM notifications WHERE kind='enquiry_received' AND to_addr='vic@example.com'")).rowCount, 1);
});

test('US2.2 an enquiry about a trip must be about the customer\'s own booking', async () => {
  const b = await book();
  const anon = await t.call('POST', '/enquiries', { body: { name: 'X', email: 'x@example.com', subject: 'Trip', message: 'Hi', bookingId: b.id } });
  assert.equal(anon.status, 401);
  const ok = await t.call('POST', '/enquiries', { token: cust, body: { name: 'Alex Morgan', email: 'customer@privatehire.test', subject: 'Luggage', message: 'We have 3 large cases.', bookingId: b.id } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.enquiry.bookingRef, b.ref);
  await t.register({ fullName: 'Pat Other', email: 'pat@example.com', phone: '07700 900321', addressLine: '2 Road', city: 'London', postcode: 'N1 9GU', password: 'Passw0rd1234' });
  const other = await t.login('pat@example.com', 'Passw0rd1234');
  const steal = await t.call('POST', '/enquiries', { token: other, body: { name: 'Pat', email: 'pat@example.com', subject: 'Not mine', message: 'x', bookingId: b.id } });
  assert.equal(steal.status, 400);
});

test('US2.3 staff inbox: newest first with status, reply is emailed and status becomes Replied', async () => {
  assert.equal((await t.call('GET', '/staff/enquiries', { token: cust })).status, 403);
  const inbox = await t.call('GET', '/staff/enquiries', { token: staff });
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.enquiries.length, 2);
  assert.ok(new Date(inbox.body.enquiries[0].createdAt) >= new Date(inbox.body.enquiries[1].createdAt), 'newest first');
  assert.ok(inbox.body.enquiries.every((e) => e.status === 'new'));
  assert.equal(inbox.body.counts.new, 2);
  const tripEnquiry = inbox.body.enquiries.find((e) => e.bookingRef);
  assert.ok(tripEnquiry, 'staff see the booking reference with the enquiry');

  const empty = await t.call('POST', `/staff/enquiries/${tripEnquiry.id}/reply`, { token: staff, body: { message: ' ' } });
  assert.equal(empty.status, 400);
  const rep = await t.call('POST', `/staff/enquiries/${tripEnquiry.id}/reply`, { token: staff, body: { message: 'Yes, we will send an estate with a large boot.' } });
  assert.equal(rep.status, 200);
  assert.equal(rep.body.enquiry.status, 'replied');
  assert.equal(rep.body.enquiry.replies[0].staffName, 'Sam Carter');
  const mail = await t.pool.query("SELECT * FROM notifications WHERE kind='enquiry_reply'");
  assert.equal(mail.rowCount, 1);
  assert.equal(mail.rows[0].to_addr, 'customer@privatehire.test');
  assert.match(mail.rows[0].body, /large boot/);
  assert.ok(mail.rows[0].sent_by);
  const replied = await t.call('GET', '/staff/enquiries?status=replied', { token: staff });
  assert.equal(replied.body.enquiries.length, 1);
  const mine = await t.call('GET', '/enquiries/mine', { token: cust });
  assert.equal(mine.body.enquiries[0].replies.length, 1, 'customer sees the answer');
});

test('US9.8 staff email a customer from the system (needs an open, verified record)', async () => {
  const blocked = await t.call('POST', `/staff/customers/${customerId}/email`, { token: staff, body: { subject: 'Hi', message: 'Hello' } });
  assert.equal(blocked.status, 403);
  await t.call('POST', `/staff/customers/${customerId}/verify`, { token: staff, body: { answers: { postcode: 'SW1A 2AA', phoneLast4: '0123' }, confirmed: true } });
  assert.equal((await t.call('POST', `/staff/customers/${customerId}/email`, { token: staff, body: { subject: '', message: '' } })).status, 400);
  const ok = await t.call('POST', `/staff/customers/${customerId}/email`, { token: staff, body: { subject: 'Your quote', message: 'Here is the quote you asked for.' } });
  assert.equal(ok.status, 201);
  const row = (await t.pool.query("SELECT * FROM notifications WHERE kind='staff_email'")).rows[0];
  assert.equal(row.to_addr, 'customer@privatehire.test');
  assert.ok(row.sent_by, 'recorded against the staff member');
  const inbox = await t.call('GET', '/notifications', { token: cust });
  assert.ok(inbox.body.notifications.some((n) => n.subject === 'Your quote'));
});

/* ---------------- dispatch ---------------- */

let job;
test('US9.9 dispatch board lists bookings needing a driver with online (priority) first', async () => {
  const soon = new Date(Date.now() + 5 * 3600_000);
  const online = await book({ pickupAt: new Date(soon.getTime() + 2 * 3600_000).toISOString() });
  await t.call('POST', `/staff/customers/${customerId}/verify`, { token: staff, body: { answers: { postcode: 'SW1A 2AA', phoneLast4: '0123' }, confirmed: true } });
  const phone = await t.call('POST', '/staff/bookings', {
    token: staff,
    body: { serviceCode: 'local', pickup: 'Camden Town', destination: 'Greenwich', pickupAt: soon.toISOString(), passengers: 2, sizeCode: 'saloon', channel: 'phone', customerId },
  });
  assert.equal(phone.status, 201, JSON.stringify(phone.body));
  const board = await t.call('GET', '/staff/dispatch', { token: staff });
  assert.equal(board.status, 200);
  const need = board.body.needsDriver;
  const iOnline = need.findIndex((b) => b.id === online.id);
  const iPhone = need.findIndex((b) => b.id === phone.body.booking.id);
  assert.ok(iOnline >= 0 && iPhone >= 0);
  assert.ok(iOnline < iPhone, 'priority online booking is listed before the earlier phone booking');
  assert.equal(need[iOnline].priority, true);
  job = online;
});

test('US9.9 assign a driver: must be free, status becomes Assigned, customer then sees the car', async () => {
  const opt = await t.call('GET', `/staff/bookings/${job.id}/options`, { token: staff });
  assert.ok(opt.body.drivers.length > 0 && opt.body.cabs.length > 0);
  assert.equal((await t.call('POST', `/staff/bookings/${job.id}/assign`, { token: staff, body: {} })).status, 400);
  const d = opt.body.drivers[0];
  const r = await t.call('POST', `/staff/bookings/${job.id}/assign`, { token: staff, body: { driverId: d.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.booking.status, 'assigned');
  assert.equal(r.body.booking.driver.phone, d.phone);
  const mine = (await t.call('GET', `/bookings/${job.id}`, { token: cust })).body.booking;
  assert.equal(mine.status, 'assigned');
  assert.ok(mine.vehicle.reg && mine.driver.name);
  assert.equal(mine.driver.phone, undefined, "the driver's phone number is not shown to customers");

  // the same driver cannot be given an overlapping job
  const clash = await book({ pickupAt: job.pickupAt });
  const c = await t.call('POST', `/staff/bookings/${clash.id}/assign`, { token: staff, body: { driverId: d.id } });
  assert.equal(c.status, 409);
  assert.equal(c.body.error.code, 'driver_busy');
});

test('US4.3 on route with ETA <= 15 sends the text with registration, colour and make - once', async () => {
  const noEta = await t.call('POST', `/staff/bookings/${job.id}/status`, { token: staff, body: { status: 'on_route' } });
  assert.equal(noEta.status, 400);

  const far = await t.call('POST', `/staff/bookings/${job.id}/status`, { token: staff, body: { status: 'on_route', etaMinutes: 40 } });
  assert.equal(far.status, 200);
  assert.equal(far.body.booking.status, 'on_route');
  assert.equal(far.body.sent.length, 0, 'ETA 40 min: too early to text');
  assert.equal((await t.pool.query("SELECT 1 FROM notifications WHERE kind='driver_near'")).rowCount, 0);

  const near = await t.call('POST', `/staff/bookings/${job.id}/status`, { token: staff, body: { status: 'on_route', etaMinutes: 12 } });
  assert.equal(near.body.sent.length, 1);
  const sms = (await t.pool.query("SELECT * FROM notifications WHERE kind='driver_near'")).rows[0];
  assert.equal(sms.channel, 'sms');
  assert.equal(sms.to_addr, '07700 900123');
  const v = near.body.booking.vehicle;
  assert.ok(sms.body.includes(v.reg) && sms.body.includes(v.colour) && sms.body.includes(v.make), 'text has reg, colour and make');
  assert.match(sms.body, /12 min/);

  const again = await t.call('POST', `/staff/bookings/${job.id}/status`, { token: staff, body: { status: 'on_route', etaMinutes: 8 } });
  assert.equal(again.body.sent.length, 0, 'never texts twice');
  assert.equal((await t.pool.query("SELECT 1 FROM notifications WHERE kind='driver_near'")).rowCount, 1);
});

test('US4.1 email-only customers get an email (not a text) when the driver is on route', async () => {
  const b = await book({ notifyPref: 'email', pickupAt: inHours(100) });
  const opt = await t.call('GET', `/staff/bookings/${b.id}/options`, { token: staff });
  await t.call('POST', `/staff/bookings/${b.id}/assign`, { token: staff, body: { driverId: opt.body.drivers[0].id } });
  const r = await t.call('POST', `/staff/bookings/${b.id}/status`, { token: staff, body: { status: 'on_route', etaMinutes: 10 } });
  assert.deepEqual(r.body.sent.map((s) => s.channel), ['email']);
  const both = await book({ notifyPref: 'both', pickupAt: inHours(120) });
  const o2 = await t.call('GET', `/staff/bookings/${both.id}/options`, { token: staff });
  await t.call('POST', `/staff/bookings/${both.id}/assign`, { token: staff, body: { driverId: o2.body.drivers[0].id } });
  const r2 = await t.call('POST', `/staff/bookings/${both.id}/status`, { token: staff, body: { status: 'on_route', etaMinutes: 15 } });
  assert.deepEqual(r2.body.sent.map((s) => s.channel).sort(), ['email', 'sms']);
});

test('US9.9 status rules: cannot skip steps; completing emails a review invitation', async () => {
  const fresh = await book({ pickupAt: inHours(150) });
  assert.equal((await t.call('POST', `/staff/bookings/${fresh.id}/status`, { token: staff, body: { status: 'completed' } })).status, 409, 'must be assigned first');
  const done = await t.call('POST', `/staff/bookings/${job.id}/status`, { token: staff, body: { status: 'completed' } });
  assert.equal(done.status, 200);
  assert.equal(done.body.booking.status, 'completed');
  assert.equal((await t.pool.query("SELECT 1 FROM notifications WHERE kind='journey_completed' AND booking_id=$1", [job.id])).rowCount, 1);
  assert.equal((await t.call('POST', `/staff/bookings/${job.id}/status`, { token: staff, body: { status: 'on_route', etaMinutes: 5 } })).status, 409, 'cannot reopen a completed journey');
  assert.equal((await t.call('POST', `/staff/bookings/${job.id}/cancel`, { token: staff, body: {} })).status, 409, 'cannot cancel a completed journey');
});

test('unassign puts the booking back on the needs-a-driver list', async () => {
  const b = await book({ pickupAt: inHours(160) });
  const opt = await t.call('GET', `/staff/bookings/${b.id}/options`, { token: staff });
  await t.call('POST', `/staff/bookings/${b.id}/assign`, { token: staff, body: { driverId: opt.body.drivers[0].id } });
  const r = await t.call('POST', `/staff/bookings/${b.id}/unassign`, { token: staff });
  assert.equal(r.body.booking.status, 'confirmed');
  assert.equal((await t.call('POST', `/staff/bookings/${b.id}/unassign`, { token: staff })).status, 409);
});

test('staff dashboard summarises the day', async () => {
  const r = await t.call('GET', '/staff/dashboard', { token: staff });
  assert.equal(r.status, 200);
  assert.ok(r.body.stats.needsDriver >= 1);
  assert.equal(typeof r.body.stats.newEnquiries, 'number');
  assert.ok(r.body.next.length > 0);
});
