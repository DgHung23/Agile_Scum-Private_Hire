import { query } from '../db.js';

/**
 * N03 + Definition of Done line 9: store who did what, to which record, and when.
 * `db` may be a transaction client so the audit row commits (or rolls back) with the action it describes.
 */
export async function audit(db, req, action, targetType = null, targetId = null, details = {}) {
  const run = db ? db.query.bind(db) : query;
  const u = req?.user;
  await run(
    `INSERT INTO audit_log (staff_id, staff_name, staff_role, action, target_type, target_id, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [u?.id || null, u?.full_name || null, u?.role || null, action, targetType, targetId ? String(targetId) : null, details, req?.ip || null],
  );
}
