import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let t;
before(async () => {
  t = await startServer();
});
after(() => t.close());

const valid = {
  fullName: 'Jamie Lee',
  email: 'Jamie.Lee@example.com',
  phone: '07700 900456',
  addressLine: '5 High Street',
  city: 'London',
  postcode: 'e1 6an',
  password: 'Sup3rSecret',
};

test('US1.1 register: validates every field and reports them all', async () => {
  const r = await t.call('POST', '/auth/register', { body: { email: 'nope', phone: '12', password: 'short' } });
  assert.equal(r.status, 400);
  const f = r.body.error.fields;
  for (const k of ['fullName', 'email', 'phone', 'addressLine', 'city', 'postcode', 'password']) {
    assert.ok(f[k], `expected an error for ${k}`);
  }
});

test('US1.1 register: success, password hashed, email normalised', async () => {
  const r = await t.call('POST', '/auth/register', { body: valid });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.email, 'jamie.lee@example.com');
  assert.equal(r.body.user.postcode, 'E1 6AN');
  assert.equal(r.body.user.role, 'customer');
  assert.equal(r.body.user.passwordHash, undefined);
  const { rows } = await t.pool.query("SELECT password_hash FROM users WHERE email='jamie.lee@example.com'");
  assert.ok(rows[0].password_hash.startsWith('$2'), 'bcrypt hash stored');
  assert.notEqual(rows[0].password_hash, valid.password);
});

test('US1.1 register: duplicate email is rejected', async () => {
  const r = await t.call('POST', '/auth/register', { body: { ...valid, email: 'JAMIE.LEE@example.com' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'email_taken');
});

test('US1.2 confirmation email is created with name and login link', async () => {
  const { rows } = await t.pool.query(
    "SELECT * FROM notifications WHERE kind='welcome' AND to_addr='jamie.lee@example.com'",
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].body, /Jamie Lee/);
  assert.match(rows[0].body, /\/login/);
});

test('US1.3 login: correct details work, wrong details give the same generic error', async () => {
  const ok = await t.call('POST', '/auth/login', { body: { email: 'jamie.lee@example.com', password: valid.password } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  const wrongPw = await t.call('POST', '/auth/login', { body: { email: 'jamie.lee@example.com', password: 'Wrong1234' } });
  const noUser = await t.call('POST', '/auth/login', { body: { email: 'ghost@example.com', password: 'Wrong1234' } });
  assert.equal(wrongPw.status, 401);
  assert.equal(noUser.status, 401);
  assert.equal(wrongPw.body.error.message, noUser.body.error.message);
});

test('US1.3 protected routes need a valid token', async () => {
  assert.equal((await t.call('GET', '/auth/me')).status, 401);
  assert.equal((await t.call('GET', '/auth/me', { token: 'garbage' })).status, 401);
  const token = await t.login('jamie.lee@example.com', valid.password);
  const me = await t.call('GET', '/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.fullName, 'Jamie Lee');
});

test('US9.1 staff and customers use separate sign-ins', async () => {
  const a = await t.call('POST', '/auth/login', { body: { email: 'staff@privatehire.test', password: 'Staff123!' } });
  assert.equal(a.status, 403);
  const b = await t.call('POST', '/auth/staff-login', {
    body: { email: 'customer@privatehire.test', password: 'Customer123!' },
  });
  assert.equal(b.status, 403);
  const s = await t.call('POST', '/auth/staff-login', { body: { email: 'staff@privatehire.test', password: 'Staff123!' } });
  assert.equal(s.status, 200);
  assert.equal(s.body.user.role, 'staff');
});

test('US9.1 a customer token cannot read the staff outbox', async () => {
  const token = await t.login('customer@privatehire.test', 'Customer123!');
  assert.equal((await t.call('GET', '/notifications?scope=all', { token })).status, 403);
  const staff = await t.login('staff@privatehire.test', 'Staff123!', true);
  const all = await t.call('GET', '/notifications?scope=all', { token: staff });
  assert.equal(all.status, 200);
  assert.ok(all.body.notifications.length >= 1);
});

test('US1.5 edit profile: validated, saved, and email must stay unique', async () => {
  const token = await t.login('jamie.lee@example.com', valid.password);
  const bad = await t.call('PATCH', '/auth/me', { token, body: { ...valid, phone: 'abc' } });
  assert.equal(bad.status, 400);
  const clash = await t.call('PATCH', '/auth/me', {
    token,
    body: { ...valid, email: 'customer@privatehire.test' },
  });
  assert.equal(clash.status, 409);
  const ok = await t.call('PATCH', '/auth/me', {
    token,
    body: { ...valid, email: 'jamie.lee@example.com', city: 'Leeds', notifyPref: 'text' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.city, 'Leeds');
  assert.equal(ok.body.user.notifyPref, 'text');
});

test('change password requires the current password', async () => {
  const token = await t.login('jamie.lee@example.com', valid.password);
  const bad = await t.call('POST', '/auth/change-password', {
    token,
    body: { currentPassword: 'nope1234', newPassword: 'N3wPassword' },
  });
  assert.equal(bad.status, 400);
  const ok = await t.call('POST', '/auth/change-password', {
    token,
    body: { currentPassword: valid.password, newPassword: 'N3wPassword' },
  });
  assert.equal(ok.status, 200);
  assert.ok(await t.login('jamie.lee@example.com', 'N3wPassword'));
});
