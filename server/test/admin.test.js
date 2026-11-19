import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let t, admin, manager;
before(async () => {
  t = await startServer();
  admin = await t.login('admin@privatehire.test', 'AdminPass123!', true);
  manager = await t.login('manager@privatehire.test', 'ManagerPass123!', true);
});
after(() => t.close());

test('N01 Admin creates a staff account with a role; the new member signs in', async () => {
  const bad = await t.call('POST', '/admin/staff', { token: admin, body: { fullName: '', email: 'x', phone: '1', role: 'boss' } });
  assert.equal(bad.status, 400);
  const r = await t.call('POST', '/admin/staff', {
    token: admin,
    body: { fullName: 'Nina Cole', email: 'nina@privatehire.test', phone: '020 7000 0099', role: 'staff', password: 'NinaPass12345' },
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, 'staff');
  assert.equal(Number(r.body.user.refundLimit), 50, 'staff get the default refund limit');
  const nina = await t.login('nina@privatehire.test', 'NinaPass12345', true);
  assert.equal((await t.call('GET', '/staff/dispatch', { token: nina })).status, 200);
  assert.equal((await t.call('POST', '/admin/staff', { token: manager, body: {} })).status, 403, 'only Admin creates staff');

  const invite = await t.call('POST', '/admin/staff', { token: admin, body: { fullName: 'Omar Reid', email: 'omar@privatehire.test', phone: '020 7000 0098', role: 'manager' } });
  assert.equal(invite.status, 201);
  const { rows } = await t.pool.query("SELECT body FROM notifications WHERE kind='staff_invite' AND to_addr='omar@privatehire.test'");
  assert.match(rows[0].body, /reset-password\?token=/, 'without a password, a set-password link is emailed');
});

test('N01 Admin changes a role and deactivates an account; the session ends at once', async () => {
  const { rows } = await t.pool.query("SELECT id FROM users WHERE email='nina@privatehire.test'");
  const nina = await t.login('nina@privatehire.test', 'NinaPass12345', true);
  const up = await t.call('PATCH', `/admin/staff/${rows[0].id}`, { token: admin, body: { role: 'manager' } });
  assert.equal(up.body.user.role, 'manager');
  await t.call('PATCH', `/admin/staff/${rows[0].id}`, { token: admin, body: { isActive: false } });
  assert.equal((await t.call('GET', '/auth/me', { token: nina })).status, 401);
  const list = await t.call('GET', '/admin/staff', { token: admin });
  assert.ok(list.body.staff.find((s) => s.email === 'nina@privatehire.test' && !s.isActive));
  const self = (await t.pool.query("SELECT id FROM users WHERE email='admin@privatehire.test'")).rows[0].id;
  assert.equal((await t.call('PATCH', `/admin/staff/${self}`, { token: admin, body: { isActive: false } })).status, 400);
});

test('N04 Admin changes settings within limits; the change is audited', async () => {
  const s = await t.call('GET', '/admin/settings', { token: admin });
  assert.ok(s.body.settings.find((x) => x.key === 'staff_refund_limit' && x.editable));
  const bad = await t.call('PUT', '/admin/settings', { token: admin, body: { online_discount_pct: 90, company_name: 1 } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.fields.online_discount_pct);
  assert.ok(bad.body.error.fields.company_name);
  const ok = await t.call('PUT', '/admin/settings', { token: admin, body: { staff_refund_limit: 60 } });
  assert.equal(ok.status, 200);
  const { rows } = await t.pool.query("SELECT refund_limit FROM users WHERE email='staff@privatehire.test'");
  assert.equal(Number(rows[0].refund_limit), 60);
  await t.call('PUT', '/admin/settings', { token: admin, body: { staff_refund_limit: 50 } });
});

test('N03 the audit log records staff actions with name and time, and filters', async () => {
  const all = await t.call('GET', '/admin/audit', { token: admin });
  assert.equal(all.status, 200);
  const create = all.body.entries.find((e) => e.action === 'staff.create');
  assert.equal(create.staffName, 'George Smith');
  assert.ok(create.at);
  const only = await t.call('GET', '/admin/audit?action=settings', { token: admin });
  assert.ok(only.body.entries.length >= 1);
  assert.ok(only.body.entries.every((e) => e.action.startsWith('settings')));
});

test('DoD line 12: the API reference is served outside production and lists every endpoint', async () => {
  const res = await fetch(t.url.replace('/api/v1', '/api/docs.json'));
  assert.equal(res.status, 200);
  const { endpoints } = await res.json();
  assert.ok(endpoints.length > 100);
  assert.ok(endpoints.some((e) => e.method === 'POST' && e.path === '/api/v1/bookings/:id/3ds'));
  const { config } = await import('../src/config.js');
  assert.equal(config.isProd, false, 'the route is only registered when NODE_ENV is not production');
});
