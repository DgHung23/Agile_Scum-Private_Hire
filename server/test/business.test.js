import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let t;
let alice; // applicant -> Business Account Admin
let bob; // invited booker
let staff;
let manager;
let company;
before(async () => {
  t = await startServer();
  staff = await t.login('staff@privatehire.test', 'StaffPass123!', true);
  manager = await t.login('manager@privatehire.test', 'ManagerPass123!', true);
  const person = (name, email) => ({ fullName: name, email, phone: '07700 900600', addressLine: '1 City Road', city: 'London', postcode: 'EC1V 1AA', password: 'Passw0rd1234' });
  await t.register(person('Alice Admin', 'alice@acme.example'));
  await t.register(person('Bob Booker', 'bob@acme.example'));
  alice = await t.login('alice@acme.example', 'Passw0rd1234');
  bob = await t.login('bob@acme.example', 'Passw0rd1234');
});
after(() => t.close());

const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const trip = (over = {}) => ({ serviceCode: 'local', pickup: 'Liverpool Street Station', destination: 'Canary Wharf', pickupAt: inHours(48), passengers: 1, sizeCode: 'saloon', ...over });
const tokenIn = async (kind, to) => (await t.pool.query('SELECT body FROM notifications WHERE kind=$1 AND to_addr=$2 ORDER BY created_at DESC LIMIT 1', [kind, to])).rows[0].body.match(/token=([A-Za-z0-9_-]+)/)[1];

test('N06 apply for a company account; validated; one pending application at a time', async () => {
  const bad = await t.call('POST', '/business/apply', { token: alice, body: { name: 'A', companiesHouseNo: '12', billingAddress: '', financeContact: '', financeEmail: 'x' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.fields.companiesHouseNo);
  const ok = await t.call('POST', '/business/apply', { token: alice, body: { name: 'Acme Ltd', companiesHouseNo: '01234567', billingAddress: '1 City Road, London EC1V 1AA', financeContact: 'Alice Admin', financeEmail: 'finance@acme.example', expectedSpend: 2000 } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.company.status, 'pending');
  company = ok.body.company;
  assert.equal((await t.call('POST', '/business/apply', { token: alice, body: { name: 'Acme Ltd', companiesHouseNo: '01234567', billingAddress: '1 City Road', financeContact: 'Alice', financeEmail: 'finance@acme.example' } })).status, 409);
  assert.equal((await t.call('GET', '/business/me', { token: alice })).body.application.status, 'pending');
});

test('N07 only the Manager approves, with a credit limit; the applicant becomes the account admin', async () => {
  assert.equal((await t.call('POST', `/staff/companies/${company.id}/approve`, { token: staff, body: { creditLimit: 100 } })).status, 403);
  const list = await t.call('GET', '/staff/companies', { token: manager });
  assert.equal(list.body.companies[0].status, 'pending');
  const ok = await t.call('POST', `/staff/companies/${company.id}/approve`, { token: manager, body: { creditLimit: 100 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.company.status, 'approved');
  const me = await t.call('GET', '/business/me', { token: alice });
  assert.equal(me.body.role, 'admin');
  assert.equal(me.body.company.creditLimit, 100);
});

test('N08 the admin invites a booker by email; the booker accepts; only the admin manages members', async () => {
  assert.equal((await t.call('POST', '/business/members/invite', { token: alice, body: { email: 'bob@acme.example' } })).status, 201);
  const token = await tokenIn('business_invite', 'bob@acme.example');
  assert.equal((await t.call('POST', '/business/join', { token: alice, body: { token } })).status, 403, 'invitation is for Bob');
  const j = await t.call('POST', '/business/join', { token: bob, body: { token } });
  assert.equal(j.status, 200);
  assert.equal(j.body.role, 'booker');
  assert.equal((await t.call('POST', '/business/members/invite', { token: bob, body: { email: 'x@acme.example' } })).status, 403);
  const me = await t.call('GET', '/business/me', { token: alice });
  assert.equal(me.body.members.length, 2);
});

let booked;
test('N09 a booker books on the company account with a cost-centre reference, shown on the receipt', async () => {
  const r = await t.book(bob, trip({ payment: { method: 'invoice', costCentre: 'SALES-42' } }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  booked = r.body.booking;
  assert.equal(booked.paymentStatus, 'invoice');
  assert.equal(booked.status, 'confirmed');
  assert.ok(booked.price.discountOnline > 0, 'still an online booking');
  const rc = (await t.call('GET', `/bookings/${booked.id}/receipt`, { token: bob })).body.receipt;
  assert.equal(rc.businessAccount.name, 'Acme Ltd');
  assert.equal(rc.businessAccount.costCentre, 'SALES-42');
  assert.equal(rc.payment.description, 'Company account (monthly invoice)');
  const personal = await t.register({ fullName: 'Pat Personal', email: 'pat@example.com', phone: '07700 900321', addressLine: '2 Road', city: 'London', postcode: 'N1 9GU', password: 'Passw0rd1234' });
  assert.equal(personal.status, 201);
  const pat = await t.login('pat@example.com', 'Passw0rd1234');
  const no = await t.book(pat, trip({ pickupAt: inHours(50), payment: { method: 'invoice' } }));
  assert.equal(no.status, 403, 'not a company member');
});

test('Table 8: over the monthly credit limit, invoice booking is refused (pay by card instead)', async () => {
  const big = await t.book(bob, trip({ serviceCode: 'long_distance', destination: 'Cambridge', pickupAt: inHours(60), payment: { method: 'invoice' } }));
  assert.equal(big.status, 402);
  assert.equal(big.body.error.code, 'credit_limit');
});

test('N12 the admin sees all company bookings and the month spend', async () => {
  const r = await t.call('GET', '/business/bookings', { token: alice });
  assert.equal(r.status, 200);
  assert.equal(r.body.bookings[0].booker, 'Bob Booker');
  assert.equal(r.body.bookings[0].costCentre, 'SALES-42');
  assert.equal(r.body.monthSpend, booked.price.total);
  assert.equal((await t.call('GET', '/business/bookings', { token: bob })).status, 403, 'bookers do not see company spend');
});

let invoice;
test('N10 one invoice for the unbilled journeys, due in 15 days; the admin pays it by card', async () => {
  const r = await t.call('POST', `/staff/companies/${company.id}/invoice`, { token: manager });
  assert.equal(r.status, 201);
  invoice = r.body.invoice;
  assert.equal(invoice.total, booked.price.total);
  const due = (new Date(invoice.dueOn) - Date.now()) / 86400_000;
  assert.ok(due > 13 && due < 16);
  assert.equal((await t.call('POST', `/staff/companies/${company.id}/invoice`, { token: manager })).status, 400, 'each journey is billed once');
  const mail = await t.pool.query("SELECT body FROM notifications WHERE kind='invoice' AND to_addr='finance@acme.example'");
  assert.match(mail.rows[0].body, new RegExp(booked.ref));
});

test('N11 overdue: reminder at day 1 and day 7, suspended at day 15 (bookers must pay by card); paying reinstates', async () => {
  await t.pool.query("UPDATE invoices SET due_on = current_date - 1 WHERE id=$1", [invoice.id]);
  assert.equal((await t.call('POST', '/staff/companies/billing-check', { token: manager })).body.actions, 1);
  assert.equal((await t.call('POST', '/staff/companies/billing-check', { token: manager })).body.actions, 0, 'one reminder per step');
  await t.pool.query("UPDATE invoices SET due_on = current_date - 7 WHERE id=$1", [invoice.id]);
  await t.call('POST', '/staff/companies/billing-check', { token: manager });
  assert.equal((await t.pool.query("SELECT 1 FROM notifications WHERE kind='invoice_overdue_alert'")).rowCount, 1, 'the Manager is alerted');
  await t.pool.query("UPDATE invoices SET due_on = current_date - 15 WHERE id=$1", [invoice.id]);
  await t.call('POST', '/staff/companies/billing-check', { token: manager });
  assert.equal((await t.call('GET', '/business/me', { token: alice })).body.company.status, 'suspended');
  const blocked = await t.book(bob, trip({ pickupAt: inHours(70), payment: { method: 'invoice' } }));
  assert.equal(blocked.status, 402);
  assert.equal(blocked.body.error.code, 'company_suspended');
  const card = { number: '4242 4242 4242 4242', expMonth: 12, expYear: 2031, cvv: '123', holder: 'Alice Admin' };
  assert.equal((await t.call('POST', `/business/invoices/${invoice.id}/pay`, { token: bob, body: { card } })).status, 403);
  assert.equal((await t.call('POST', `/business/invoices/${invoice.id}/pay`, { token: alice, body: { card } })).status, 200);
  assert.equal((await t.call('GET', '/business/me', { token: alice })).body.company.status, 'approved', 'reinstated');
});

test('Table 8: when a booker leaves, the admin is told about their future company bookings', async () => {
  const b = await t.book(bob, trip({ pickupAt: inHours(80), payment: { method: 'invoice' } }));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const me = await t.call('GET', '/business/me', { token: alice });
  const member = me.body.members.find((m) => m.email === 'bob@acme.example');
  const r = await t.call('DELETE', `/business/members/${member.id}`, { token: alice });
  assert.equal(r.status, 200);
  assert.equal(r.body.futureBookings.length, 2, 'both of his future company journeys');
  assert.equal((await t.call('GET', '/business/me', { token: bob })).body.company, null);
});

test('N07 a rejected application gets the reason by email', async () => {
  await t.call('POST', '/business/apply', { token: (await t.login('pat@example.com', 'Passw0rd1234')), body: { name: 'Fake Co', companiesHouseNo: '99999999', billingAddress: 'Nowhere Street', financeContact: 'Pat', financeEmail: 'pat@example.com' } });
  const fake = (await t.call('GET', '/staff/companies', { token: manager })).body.companies.find((c) => c.name === 'Fake Co');
  const r = await t.call('POST', `/staff/companies/${fake.id}/reject`, { token: manager, body: { reason: 'The company number does not check out' } });
  assert.equal(r.body.company.status, 'rejected');
  const mail = await t.pool.query("SELECT body FROM notifications WHERE kind='business_rejected'");
  assert.match(mail.rows[0].body, /does not check out/);
});
