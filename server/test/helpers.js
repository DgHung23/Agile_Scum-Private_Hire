// Test harness: isolated database (privatehire_test), fresh schema per test file, app on a random port.
process.env.NODE_ENV = 'test';
const BASE = process.env.TEST_DATABASE_ADMIN_URL || 'postgres://privatehire:privatehire_dev@localhost:5433';
process.env.DATABASE_URL = `${BASE}/privatehire_test`;

import pg from 'pg';

export async function startServer({ seedData = true } = {}) {
  const admin = new pg.Client({ connectionString: `${BASE}/postgres` });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname='privatehire_test'");
  if (!exists.rowCount) await admin.query('CREATE DATABASE privatehire_test');
  await admin.end();

  const { migrate } = await import('../src/migrate.js');
  const { seed } = await import('../src/seed.js');
  const { createApp } = await import('../src/app.js');
  const { pool } = await import('../src/db.js');
  await migrate({ reset: true });
  if (seedData) await seed();
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/api/v1`;

  const call = async (method, p, { token, body } = {}) => {
    const res = await fetch(url + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Client': 'app', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const login = async (email, password, staff = false) => {
    const r = await call('POST', staff ? '/auth/staff-login' : '/auth/login', { body: { email, password } });
    return r.body?.token;
  };
  /** Register through the API, then mark the email verified (as if the customer clicked the link). */
  const register = async (body, { verify = true } = {}) => {
    const r = await call('POST', '/auth/register', { body });
    if (verify && r.status === 201) await pool.query('UPDATE users SET email_verified=true WHERE email=lower($1)', [body.email]);
    const { rows } = await pool.query('SELECT id, email, full_name FROM users WHERE email=lower($1)', [body.email || '']);
    return { ...r, user: rows[0] };
  };
  const close = async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  };
  return { url, call, login, register, close, pool };
}
