import crypto from 'node:crypto';
import { pool, query } from '../db.js';
import { HttpError } from '../errors.js';
import { sendEmail } from './notify.js';

/*
 * Business accounts (report Section 2.1 and Table 8; stories N06 to N12).
 * - An approved company has a monthly credit limit. Bookers book "on account" with an optional cost-centre reference.
 * - One invoice per company is issued for the bookings not yet billed, due in 15 days.
 * - Overdue: day 1 reminder, day 7 second reminder and the Manager is alerted, day 15 the account is suspended and
 *   invoice booking is blocked (bookers can still pay by personal card). Paying the invoice reinstates the account.
 */
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const gbp = (n) => `GBP ${Number(n).toFixed(2)}`;

/** The customer's active company membership, if any. */
export async function membership(db, userId) {
  const run = db ? db.query.bind(db) : query;
  const { rows } = await run(
    `SELECT m.id AS member_id, m.member_role, c.*
       FROM company_members m JOIN companies c ON c.id = m.company_id
      WHERE m.customer_id=$1 AND m.active`,
    [userId],
  );
  return rows[0] || null;
}

/** Spend on account this calendar month (London time), not counting cancelled bookings. */
export async function monthSpend(db, companyId) {
  const run = db ? db.query.bind(db) : query;
  const { rows } = await run(
    `SELECT COALESCE(sum(total), 0) AS spend FROM bookings
      WHERE company_id=$1 AND payment_status='invoice'
        AND status NOT IN ('cancelled','company_cancelled','abandoned')
        AND date_trunc('month', created_at AT TIME ZONE 'Europe/London') = date_trunc('month', now() AT TIME ZONE 'Europe/London')`,
    [companyId],
  );
  return r2(Number(rows[0].spend));
}

/** N09 + Table 8: may this customer book this amount on the company account? Throws a clear error otherwise. */
export async function checkCanUseAccount(db, userId, amount) {
  const m = await membership(db, userId);
  if (!m) throw new HttpError(403, 'You are not a booker on a company account.', 'no_company');
  if (m.status === 'suspended') {
    throw new HttpError(402, 'Your company account is suspended because an invoice is overdue. Please pay by card this time.', 'company_suspended');
  }
  if (m.status !== 'approved') throw new HttpError(403, 'Your company account is not active.', 'company_inactive');
  const spend = await monthSpend(db, m.id);
  if (m.credit_limit != null && spend + amount > Number(m.credit_limit) + 0.001) {
    throw new HttpError(
      402,
      `This booking would take your company over its monthly credit limit of ${gbp(m.credit_limit)} (${gbp(spend)} used). Please pay by card, or ask your account admin to contact us.`,
      'credit_limit',
    );
  }
  return m;
}

const invoiceNumber = () => `INV-${new Date().toISOString().slice(0, 7).replace('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

/** N10: one invoice for every booking on account that is not billed yet. Returns null when there is nothing to bill. */
export async function issueInvoice(db, company, actor = null) {
  const { rows: lines } = await db.query(
    `SELECT b.id, b.total, b.ref, b.pickup_at FROM bookings b
      WHERE b.company_id=$1 AND b.payment_status='invoice' AND b.status NOT IN ('cancelled','company_cancelled','abandoned')
        AND NOT EXISTS (SELECT 1 FROM invoice_lines l WHERE l.booking_id=b.id)
      ORDER BY b.pickup_at`,
    [company.id],
  );
  if (!lines.length) return null;
  const total = r2(lines.reduce((a, l) => a + Number(l.total), 0));
  const start = lines[0].pickup_at;
  const end = lines[lines.length - 1].pickup_at;
  const { rows } = await db.query(
    `INSERT INTO invoices (number, company_id, period_start, period_end, due_on, total)
     VALUES ($1,$2,$3::timestamptz::date,$4::timestamptz::date,(now() + interval '15 days')::date,$5) RETURNING *`,
    [invoiceNumber(), company.id, start, end, total],
  );
  for (const l of lines) await db.query('INSERT INTO invoice_lines (invoice_id, booking_id, amount) VALUES ($1,$2,$3)', [rows[0].id, l.id, l.total]);
  await sendEmail({
    to: company.finance_email, kind: 'invoice', sentBy: actor?.id || null,
    subject: `Invoice ${rows[0].number} - ${gbp(total)} due ${rows[0].due_on.toISOString?.().slice(0, 10) || rows[0].due_on}`,
    body: `Hello ${company.finance_contact},\n\nInvoice ${rows[0].number} for ${company.name} covers ${lines.length} journey(s): ${gbp(total)}.\nPlease pay within 15 days from the Business account page.\n\n${lines.map((l) => `${l.ref}  ${gbp(l.total)}`).join('\n')}\n\nThe Private Hire Cars team`,
  }, db);
  return rows[0];
}

/** N11: reminders on day 1 and day 7 overdue, suspension on day 15. Run daily (and on demand). */
export async function billingCheck() {
  const client = await pool.connect();
  let actions = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT i.*, (current_date - i.due_on) AS days_over, c.name, c.finance_email, c.finance_contact, c.status AS company_status
         FROM invoices i JOIN companies c ON c.id = i.company_id
        WHERE i.status IN ('open','overdue') AND i.due_on < current_date FOR UPDATE OF i`,
    );
    for (const i of rows) {
      const days = Number(i.days_over);
      if (i.status === 'open') await client.query("UPDATE invoices SET status='overdue' WHERE id=$1", [i.id]);
      const step = days >= 15 ? 3 : days >= 7 ? 2 : 1;
      if (step <= i.reminders_sent) continue;
      const text =
        step === 3
          ? `Invoice ${i.number} is now 15 days overdue, so the account is suspended: bookers can still travel but must pay by card. Pay the invoice to reinstate it.`
          : step === 2
            ? `Second reminder: invoice ${i.number} (${gbp(i.total)}) is 7 days overdue. The account will be suspended at 15 days.`
            : `Reminder: invoice ${i.number} (${gbp(i.total)}) was due on ${String(i.due_on).slice(0, 10)}. Please pay it from the Business account page.`;
      await sendEmail({ to: i.finance_email, kind: 'invoice_overdue', subject: `Overdue invoice ${i.number}`, body: `Hello ${i.finance_contact},\n\n${text}\n\nThe Private Hire Cars team` }, client);
      if (step >= 2) {
        await sendEmail({ to: 'manager@privatehire.test', kind: 'invoice_overdue_alert', subject: `${i.name}: invoice ${i.number} ${days} days overdue`, body: `${i.name} has not paid invoice ${i.number} (${gbp(i.total)}), ${days} days overdue.` }, client);
      }
      if (step === 3 && i.company_status === 'approved') {
        await client.query("UPDATE companies SET status='suspended', status_reason=$2 WHERE id=$1", [i.company_id, `Invoice ${i.number} 15 days overdue`]);
      }
      await client.query('UPDATE invoices SET reminders_sent=$2, last_reminder_at=now() WHERE id=$1', [i.id, step]);
      actions++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return actions;
}
