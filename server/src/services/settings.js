import { query } from '../db.js';

/** Business rules live in the `settings` table so the Admin can change them without a deployment (N04). */
export async function allSettings(db) {
  const run = db ? db.query.bind(db) : query;
  const { rows } = await run('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function getNumber(key, fallback, db) {
  const run = db ? db.query.bind(db) : query;
  const { rows } = await run('SELECT value FROM settings WHERE key = $1', [key]);
  const n = Number(rows[0]?.value);
  return Number.isFinite(n) ? n : fallback;
}
