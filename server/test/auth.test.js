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
  password: 'Sup3rSecretPass',
};

const tokenFrom = async (kind, email) => {
  const { rows } = await t.pool.query('SELECT body FROM notifications WHERE kind=$1 AND to_addr=$2 ORDER BY created_at DESC LIMIT 1', [kind, email]);
  return rows[0]?.body.match(/token=([A-Za-z0-9_-]+)/)?.[1];
};

test('ID-11 register: validates every field and reports them all', async () => {
  const r = await t.register({ email: 'nope', phone: '12', password: 'short' });
  assert.equal(r.status, 400);
  const f = r.body.error.fields;
  for (const k of ['fullName', 'email', 'phone', 'addressLine', 'city', 'postcode', 'password']) {
    assert.ok(f[k], `expected an error for ${k}`);
  }
  assert.equal(f.fullName, 'Full name is required', 'missing fields get friendly messages, not zod internals');
  assert.equal(f.password, 'Use at least 12 characters', 'ID-11 criterion 1: at least 12 characters');
});

test('ID-11 register: success with consent unticked, password hashed, email normalised, not yet verified', async () => {
  const r = await t.register(valid, { verify: false });
  assert.equal(r.status, 201);
  assert.equal(r.body.user, undefined, 'the reply does not reveal account data');
  const { rows } = await t.pool.query("SELECT * FROM users WHERE email='jamie.lee@example.com'");
  assert.ok(rows[0].password_hash.startsWith('$2'), 'bcrypt hash stored');
  assert.equal(rows[0].postcode, 'E1 6AN');
  assert.equal(rows[0].marketing_consent, false);
  assert.equal(rows[0].email_verified, false);
});

test('ID-11 red-team row 1: an existing email gets the same reply, and the owner is emailed', async () => {
  const fresh = await t.register({ ...valid, email: 'someone.new@example.com' }, { verify: false });
  const dup = await t.register({ ...valid, email: 'JAMIE.LEE@example.com' }, { verify: false });
  assert.equal(dup.status, fresh.status);
  assert.deepEqual(dup.body, fresh.body);
  const { rows } = await t.pool.query("SELECT 1 FROM notifications WHERE kind='register_attempt' AND to_addr='jamie.lee@example.com'");
  assert.equal(rows.length, 1);
});

test('ID-12 confirmation email with name and login link, plus a verify link', async () => {
  const { rows } = await t.pool.query("SELECT * FROM notifications WHERE kind='welcome' AND to_addr='jamie.lee@example.com'");
  assert.equal(rows.length, 1);
  assert.match(rows[0].body, /Jamie Lee/);
  assert.match(rows[0].body, /\/login/);
  assert.ok(await tokenFrom('verify_email', 'jamie.lee@example.com'));
});

test('ID-11 criterion 5: an unverified customer cannot book until the link is used', async () => {
  const token = await t.login('jamie.lee@example.com', valid.password);
  const me = await t.call('GET', '/auth/me', { token });
  assert.equal(me.body.user.emailVerified, false);
  const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString();
  const b = await t.call('POST', '/bookings', {
    token,
    body: { serviceCode: 'local', pickup: 'Waterloo Station', destination: 'Camden Town', pickupAt: tomorrow, passengers: 1, sizeCode: 'saloon', payment: { method: 'card', card: { number: '4242424242424242', expMonth: 12, expYear: 2030, cvc: '123', holderName: 'J Lee' } } },
  });
  assert.equal(b.status, 403);
  assert.equal(b.body.error.code, 'email_not_verified');

  const link = await tokenFrom('verify_email', 'jamie.lee@example.com');
  assert.equal((await t.call('POST', '/auth/verify-email', { body: { token: 'x'.repeat(30) } })).status, 400);
  assert.equal((await t.call('POST', '/auth/verify-email', { body: { token: link } })).status, 200);
  assert.equal((await t.call('POST', '/auth/verify-email', { body: { token: link } })).status, 400, 'single use');
  assert.equal((await t.call('GET', '/auth/me', { token })).body.user.emailVerified, true);
});

test('ID-13 login: correct details work, wrong details give the same generic error', async () => {
  const ok = await t.call('POST', '/auth/login', { body: { email: 'jamie.lee@example.com', password: valid.password } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token, 'apps get the session id in the body');
  const wrongPw = await t.call('POST', '/auth/login', { body: { email: 'jamie.lee@example.com', password: 'Wrong1234' } });
  const noUser = await t.call('POST', '/auth/login', { body: { email: 'ghost@example.com', password: 'Wrong1234' } });
  assert.equal(wrongPw.status, 401);
  assert.equal(noUser.status, 401);
  assert.equal(wrongPw.body.error.message, noUser.body.error.message);
});

test('ID-13 the browser gets an HttpOnly cookie and no token in the body', async () => {
  const res = await fetch(t.url + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'jamie.lee@example.com', password: valid.password }),
  });
  const data = await res.json();
  assert.equal(data.token, undefined);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /ph_sid=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const sid = cookie.split(';')[0];
  const me = await fetch(t.url + '/auth/me', { headers: { Cookie: sid } });
  assert.equal(me.status, 200);
  // A state-changing request that relies on the cookie needs the client header (CSRF guard).
  const blocked = await fetch(t.url + '/auth/logout', { method: 'POST', headers: { Cookie: sid } });
  assert.equal(blocked.status, 403);
  const out = await fetch(t.url + '/auth/logout', { method: 'POST', headers: { Cookie: sid, 'X-PH-Client': 'web' } });
  assert.equal(out.status, 200);
  assert.equal((await fetch(t.url + '/auth/me', { headers: { Cookie: sid } })).status, 401, 'logout ends the session on the server');
});

test('ID-13 criterion 5: a session ends after 30 minutes without activity', async () => {
  const token = await t.login('jamie.lee@example.com', valid.password);
  assert.equal((await t.call('GET', '/auth/me', { token })).status, 200);
  await t.pool.query("UPDATE sessions SET last_seen_at = now() - interval '31 minutes' WHERE revoked_at IS NULL");
  const r = await t.call('GET', '/auth/me', { token });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'session_expired');
});

test('ID-13 lockout: 5 failures from one IP lock that account there; the email link unlocks it', async () => {
  await t.register({ ...valid, email: 'lockme@example.com' });
  for (let i = 0; i < 4; i++) {
    assert.equal((await t.call('POST', '/auth/login', { body: { email: 'lockme@example.com', password: 'WrongPass9999' } })).status, 401);
  }
  const fifth = await t.call('POST', '/auth/login', { body: { email: 'lockme@example.com', password: 'WrongPass9999' } });
  assert.equal(fifth.status, 429);
  assert.equal(fifth.body.error.code, 'account_locked');
  const right = await t.call('POST', '/auth/login', { body: { email: 'lockme@example.com', password: valid.password } });
  assert.equal(right.status, 429, 'even the right password waits while locked');
  // The same error for an unknown email after 5 tries: no account enumeration.
  for (let i = 0; i < 5; i++) await t.call('POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'WrongPass9999' } });
  assert.equal((await t.call('POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'x' } })).body.error.code, 'account_locked');

  const unlock = await tokenFrom('account_locked', 'lockme@example.com');
  assert.ok(unlock, 'the owner is emailed an unlock link');
  assert.equal((await t.call('POST', '/auth/unlock', { body: { token: unlock } })).status, 200);
  assert.equal((await t.call('POST', '/auth/login', { body: { email: 'lockme@example.com', password: valid.password } })).status, 200);
});

test('ID-13 protected routes need a valid session', async () => {
  assert.equal((await t.call('GET', '/auth/me')).status, 401);
  assert.equal((await t.call('GET', '/auth/me', { token: 'garbage' })).status, 401);
  const token = await t.login('jamie.lee@example.com', valid.password);
  const me = await t.call('GET', '/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.fullName, 'Jamie Lee');
});

test('ID-18 staff and customers use separate sign-ins; manager, admin and driver use the staff one', async () => {
  const a = await t.call('POST', '/auth/login', { body: { email: 'staff@privatehire.test', password: 'StaffPass123!' } });
  assert.equal(a.status, 403);
  const b = await t.call('POST', '/auth/staff-login', { body: { email: 'customer@privatehire.test', password: 'Customer123!' } });
  assert.equal(b.status, 403);
  for (const [email, pw, role] of [
    ['staff@privatehire.test', 'StaffPass123!', 'staff'],
    ['manager@privatehire.test', 'ManagerPass123!', 'manager'],
    ['admin@privatehire.test', 'AdminPass123!', 'admin'],
  ]) {
    const s = await t.call('POST', '/auth/staff-login', { body: { email, password: pw } });
    assert.equal(s.status, 200);
    assert.equal(s.body.user.role, role);
  }
});

test('ID-18 role checks on the server: customer 403 on staff pages, admin 403 on bookings, manager inherits staff', async () => {
  const cust = await t.login('customer@privatehire.test', 'Customer123!');
  const staff = await t.login('staff@privatehire.test', 'StaffPass123!', true);
  const manager = await t.login('manager@privatehire.test', 'ManagerPass123!', true);
  const admin = await t.login('admin@privatehire.test', 'AdminPass123!', true);
  assert.equal((await t.call('GET', '/staff/dispatch', { token: cust })).status, 403);
  assert.equal((await t.call('GET', '/staff/dispatch', { token: staff })).status, 200);
  assert.equal((await t.call('GET', '/staff/dispatch', { token: manager })).status, 200, 'Manager inherits Call Centre Staff');
  assert.equal((await t.call('GET', '/staff/dispatch', { token: admin })).status, 403, 'Admin does not handle bookings');
  assert.equal((await t.call('GET', '/admin/audit', { token: manager })).status, 403);
  assert.equal((await t.call('GET', '/admin/audit', { token: admin })).status, 200);
  assert.equal((await t.call('POST', '/staff/cabs', { token: staff, body: {} })).status, 403, 'only the Manager adds cabs');
});

test('ID-18 a customer session cannot read the staff outbox', async () => {
  const token = await t.login('customer@privatehire.test', 'Customer123!');
  assert.equal((await t.call('GET', '/notifications?scope=all', { token })).status, 403);
  const staff = await t.login('staff@privatehire.test', 'StaffPass123!', true);
  const all = await t.call('GET', '/notifications?scope=all', { token: staff });
  assert.equal(all.status, 200);
  assert.ok(all.body.notifications.length >= 1);
});

test('ID-15 edit profile and marketing consent; changing the email needs the current password', async () => {
  const token = await t.login('jamie.lee@example.com', valid.password);
  const bad = await t.call('PATCH', '/auth/me', { token, body: { ...valid, phone: 'abc' } });
  assert.equal(bad.status, 400);
  const ok = await t.call('PATCH', '/auth/me', {
    token,
    body: { ...valid, email: 'jamie.lee@example.com', city: 'Leeds', notifyPref: 'text', marketingConsent: true },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.city, 'Leeds');
  assert.equal(ok.body.user.notifyPref, 'text');
  assert.equal(ok.body.user.marketingConsent, true);

  const noPw = await t.call('PATCH', '/auth/me', { token, body: { ...valid, email: 'jamie.new@example.com' } });
  assert.equal(noPw.status, 400);
  assert.equal(noPw.body.error.code, 'password_required');
  const clash = await t.call('PATCH', '/auth/me', { token, body: { ...valid, email: 'customer@privatehire.test', currentPassword: valid.password } });
  assert.equal(clash.status, 409);
  const moved = await t.call('PATCH', '/auth/me', { token, body: { ...valid, email: 'jamie.new@example.com', currentPassword: valid.password } });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.user.emailVerified, false, 'the new address must be verified');
  const { rows } = await t.pool.query("SELECT 1 FROM notifications WHERE kind='email_changed' AND to_addr='jamie.lee@example.com'");
  assert.equal(rows.length, 1, 'confirmation goes to the old address');
  assert.ok(await tokenFrom('verify_email', 'jamie.new@example.com'));
});

test('N02 change password requires the current password and signs out other devices', async () => {
  const token = await t.login('jamie.new@example.com', valid.password);
  const other = await t.login('jamie.new@example.com', valid.password);
  const bad = await t.call('POST', '/auth/change-password', { token, body: { currentPassword: 'nope1234', newPassword: 'N3wPasswordXYZ' } });
  assert.equal(bad.status, 400);
  const ok = await t.call('POST', '/auth/change-password', { token, body: { currentPassword: valid.password, newPassword: 'N3wPasswordXYZ' } });
  assert.equal(ok.status, 200);
  assert.equal((await t.call('GET', '/auth/me', { token })).status, 200, 'this device stays signed in');
  assert.equal((await t.call('GET', '/auth/me', { token: other })).status, 401, 'other devices are signed out');
  assert.ok(await t.login('jamie.new@example.com', 'N3wPasswordXYZ'));
});

test('ID-20 the secret word is stored hashed and needs the current password', async () => {
  const token = await t.login('jamie.new@example.com', 'N3wPasswordXYZ');
  assert.equal((await t.call('PUT', '/auth/me/secret-word', { token, body: { secretWord: 'otter', currentPassword: 'wrong' } })).status, 400);
  assert.equal((await t.call('PUT', '/auth/me/secret-word', { token, body: { secretWord: 'otter', currentPassword: 'N3wPasswordXYZ' } })).status, 200);
  const { rows } = await t.pool.query("SELECT secret_word_hash FROM users WHERE email='jamie.new@example.com'");
  assert.ok(rows[0].secret_word_hash.startsWith('$2'));
  assert.equal((await t.call('GET', '/auth/me', { token })).body.user.hasSecretWord, true);
});
