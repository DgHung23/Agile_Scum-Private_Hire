import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { workingDaysFrom } from '../src/routes/support.js';

let t;
let cust;
let staff;
let manager;
let admin;
let custId;
let booking;
before(async () => {
  t = await startServer();
  cust = await t.login('customer@privatehire.test', 'Customer123!');
  staff = await t.login('staff@privatehire.test', 'StaffPass123!', true);
  manager = await t.login('manager@privatehire.test', 'ManagerPass123!', true);
  admin = await t.login('admin@privatehire.test', 'AdminPass123!', true);
  custId = (await t.pool.query("SELECT id FROM users WHERE email='customer@privatehire.test'")).rows[0].id;
  const r = await t.book(cust, {
    serviceCode: 'local', pickup: 'Camden Town', destination: 'Brixton', pickupAt: new Date(Date.now() + 40 * 3600_000).toISOString(),
    passengers: 2, sizeCode: 'saloon', payment: { method: 'card', card: { number: '4242 4242 4242 4242', expMonth: 12, expYear: 2031, cvv: '123', holder: 'Alex Morgan' } },
  });
  booking = r.body.booking;
});
after(() => t.close());

const verify = () => t.call('POST', `/staff/customers/${custId}/verify`, { token: staff, body: { answers: { postcode: 'SW1A 2AA', phoneLast4: '0123', secretWord: 'bluebird' }, confirmed: true } });

test('N23 a customer reports a lost item on their journey; someone without an account uses the reference and email', async () => {
  const r = await t.call('POST', '/support/lost-items', { token: cust, body: { bookingId: booking.id, description: 'Black umbrella', colour: 'Black' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.item.status, 'searching');
  const visitor = await t.call('POST', '/support/lost-items', { body: { bookingRef: booking.ref, email: 'customer@privatehire.test', description: 'Blue scarf' } });
  assert.equal(visitor.status, 201);
  const bad = await t.call('POST', '/support/lost-items', { body: { bookingRef: booking.ref, email: 'someone@else.com', description: 'Phone' } });
  assert.equal(bad.status, 400, 'red-team row 11: tied to a real booking');
  assert.equal((await t.call('GET', '/support/lost-items', { token: cust })).body.items.length, 2);
});

test('N28, N36 a found item on the same booking matches the report automatically and the customer is told', async () => {
  const f = await t.call('POST', '/staff/lost-items', { token: staff, body: { bookingRef: booking.ref, description: 'Umbrella, black, back seat' } });
  assert.equal(f.status, 201);
  assert.equal(f.body.item.status, 'found');
  assert.ok(f.body.item.matchedWith);
  const mine = (await t.call('GET', '/support/lost-items', { token: cust })).body.items;
  assert.ok(mine.some((i) => i.status === 'found'));
  const upd = await t.call('PATCH', `/staff/lost-items/${f.body.item.matchedWith}`, { token: staff, body: { status: 'ready' } });
  assert.equal(upd.status, 200);
  const msgs = await t.pool.query("SELECT body FROM notifications WHERE kind='lost_item' AND to_addr='customer@privatehire.test' ORDER BY created_at DESC LIMIT 1");
  assert.match(msgs.rows[0].body, /Ready to collect/);
});

test('N24 a complaint is acknowledged with an answer date 5 working days ahead; staff answer it', async () => {
  assert.equal(workingDaysFrom(new Date('2026-11-20T10:00:00Z'), 5).toISOString().slice(0, 10), '2026-11-27', 'Friday + 5 working days = next Friday');
  const c = await t.call('POST', '/support/complaints', { token: cust, body: { bookingId: booking.id, category: 'driver', text: 'The driver was rude and drove too fast.' } });
  assert.equal(c.status, 201);
  const days = (new Date(c.body.complaint.dueBy) - Date.now()) / 86400_000;
  assert.ok(days >= 5 && days <= 9);
  const list = await t.call('GET', '/staff/complaints', { token: staff });
  const mine = list.body.complaints.find((x) => x.id === c.body.complaint.id);
  assert.equal(mine.status, 'open');
  const a = await t.call('POST', `/staff/complaints/${mine.id}/answer`, { token: staff, body: { answer: 'We are sorry. We have spoken to the driver.' } });
  assert.equal(a.body.complaint.status, 'answered');
  assert.equal((await t.pool.query("SELECT 1 FROM notifications WHERE kind='complaint_answer'")).rowCount, 1);
});

test('N33 the Manager acts on a driver after a complaint; staff cannot', async () => {
  const c = (await t.call('GET', '/staff/complaints', { token: manager })).body.complaints[0];
  assert.equal((await t.call('POST', `/staff/complaints/${c.id}/driver-action`, { token: staff, body: { action: 'Warning' } })).status, 403);
  const r = await t.call('POST', `/staff/complaints/${c.id}/driver-action`, { token: manager, body: { action: 'Written warning and retraining' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.complaint.driverAction, 'Written warning and retraining');
});

test('N29 staff add notes to a verified customer account', async () => {
  assert.equal((await t.call('POST', `/staff/customers/${custId}/notes`, { token: staff, body: { body: 'Prefers a quiet ride' } })).status, 403);
  await verify();
  assert.equal((await t.call('POST', `/staff/customers/${custId}/notes`, { token: staff, body: { body: 'Prefers a quiet ride' } })).status, 201);
  const n = await t.call('GET', `/staff/customers/${custId}/notes`, { token: staff });
  assert.equal(n.body.notes[0].by, 'Sam Carter');
});

test('ID-22 favourite places: save, list, unique names, delete', async () => {
  const a = await t.call('POST', '/support/favourites', { token: cust, body: { label: 'Home', address: '10 Downing Street, London' } });
  assert.equal(a.status, 201);
  assert.equal((await t.call('POST', '/support/favourites', { token: cust, body: { label: 'Home', address: 'x street' } })).status, 409);
  const list = await t.call('GET', '/support/favourites', { token: cust });
  assert.equal(list.body.favourites[0].label, 'Home');
  assert.equal((await t.call('DELETE', `/support/favourites/${a.body.favourite.id}`, { token: cust })).status, 200);
});

test('ID-60 staff hide abusive review text; the ratings stay', async () => {
  await t.pool.query("UPDATE bookings SET status='completed' WHERE id=$1", [booking.id]);
  await t.call('POST', `/bookings/${booking.id}/review`, { token: cust, body: { journeyRating: 1, cabRating: 2, driverRating: 1, comment: 'Abusive words here' } });
  const r = (await t.call('GET', '/staff/reviews', { token: staff })).body.reviews.find((x) => x.bookingRef === booking.ref);
  assert.equal((await t.call('POST', `/staff/reviews/${r.id}/hide`, { token: staff, body: { hidden: true, reason: 'Abusive language' } })).status, 200);
  const after = (await t.call('GET', '/staff/reviews', { token: staff })).body.reviews.find((x) => x.id === r.id);
  assert.equal(after.hidden, true);
  assert.equal(after.journeyRating, 1);
});

test('ID-16 download my data, then delete my account (records stay without the name)', async () => {
  const res = await fetch(`${t.url}/support/my-data`, { headers: { Authorization: `Bearer ${cust}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /PrivateHire-my-data\.json/);
  const data = await res.json();
  assert.equal(data.profile.email, 'customer@privatehire.test');
  assert.ok(data.bookings.length >= 1);
  assert.ok(!JSON.stringify(data).includes('password'), 'no password hash in the export');

  await t.register({ fullName: 'Short Stay', email: 'short@example.com', phone: '07700 900444', addressLine: '1 Road', city: 'London', postcode: 'N1 9GU', password: 'Passw0rd1234' });
  const tok = await t.login('short@example.com', 'Passw0rd1234');
  assert.equal((await t.call('POST', '/support/delete-account', { token: tok, body: { currentPassword: 'wrong' } })).status, 400);
  assert.equal((await t.call('POST', '/support/delete-account', { token: tok, body: { currentPassword: 'Passw0rd1234' } })).status, 200);
  assert.equal((await t.call('GET', '/auth/me', { token: tok })).status, 401, 'signed out everywhere');
  const u = (await t.pool.query("SELECT full_name, is_active FROM users WHERE email LIKE 'deleted-%'")).rows[0];
  assert.equal(u.full_name, 'Deleted customer');
  assert.equal(u.is_active, false);
  // a customer with upcoming journeys must cancel them first
  await t.pool.query("UPDATE bookings SET status='confirmed' WHERE id=$1", [booking.id]);
  assert.equal((await t.call('POST', '/support/delete-account', { token: cust, body: { currentPassword: 'Customer123!' } })).status, 409);
});

test('N05 the retention job deletes records older than 12 months', async () => {
  const old = await t.pool.query("UPDATE bookings SET pickup_at = now() - interval '14 months', end_at = now() - interval '14 months' + interval '1 hour' WHERE id=$1 RETURNING id", [booking.id]);
  assert.equal(old.rowCount, 1);
  const r = await t.call('POST', '/admin/jobs/retention', { token: admin });
  assert.ok(r.body.done >= 1);
  assert.equal((await t.pool.query('SELECT 1 FROM bookings WHERE id=$1', [booking.id])).rowCount, 0);
  assert.equal((await t.pool.query('SELECT 1 FROM receipts WHERE booking_id=$1', [booking.id])).rowCount, 0, 'receipts go with the booking');
});
