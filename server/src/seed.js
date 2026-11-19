import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from './db.js';
import { migrate } from './migrate.js';

/** Demo accounts - safe to run repeatedly (idempotent). Passwords are for local demo only. */
export const DEMO = {
  admin: { email: 'admin@privatehire.test', password: 'Admin123!', name: 'George Smith', role: 'admin', phone: '020 7000 0001' },
  staff: { email: 'staff@privatehire.test', password: 'Staff123!', name: 'Sam Carter', role: 'staff', phone: '020 7000 0002' },
  customer: { email: 'customer@privatehire.test', password: 'Customer123!', name: 'Alex Morgan', role: 'customer', phone: '07700 900123' },
};

async function upsertUser(u, extra = {}) {
  const hash = await bcrypt.hash(u.password, 10);
  await query(
    `INSERT INTO users (role,email,password_hash,full_name,phone,address_line,city,postcode,notify_pref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (email) DO NOTHING`,
    [
      u.role,
      u.email,
      hash,
      u.name,
      u.phone,
      extra.address || '10 Downing Street',
      'London',
      extra.postcode || 'SW1A 2AA',
      extra.notify || 'both',
    ],
  );
}

export async function seed() {
  for (const u of Object.values(DEMO)) await upsertUser(u);
  console.log('[seed] demo accounts ready');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate()
    .then(seed)
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
