import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { config } from '../config.js';
import { customerOnly, managerOnly } from '../middleware/auth.js';
import { body, wrap } from '../middleware/validate.js';
import { HttpError, badRequest, notFound } from '../errors.js';
import { emailSchema } from '../schemas.js';
import { audit } from '../services/audit.js';
import { billingCheck, issueInvoice, membership, monthSpend } from '../services/business.js';
import { sendEmail } from '../services/notify.js';
import { cardInputSchema, detectBrand, simOutcome, visaCheck } from '../services/payments.js';

/** Business accounts (N06 to N12). */
export const router = Router(); // /business (customers)
export const staffRouter = Router(); // /staff (Manager)

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const serializeCompany = (c) => ({
  id: c.id,
  name: c.name,
  companiesHouseNo: c.companies_house_no,
  billingAddress: c.billing_address,
  financeContact: c.finance_contact,
  financeEmail: c.finance_email,
  accountType: c.account_type,
  expectedSpend: c.expected_spend,
  creditLimit: c.credit_limit,
  status: c.status,
  statusReason: c.status_reason,
  createdAt: c.created_at,
  approvedAt: c.approved_at,
});
const serializeInvoice = (i) => ({
  id: i.id, number: i.number, periodStart: i.period_start, periodEnd: i.period_end, issuedAt: i.issued_at, dueOn: i.due_on,
  total: Number(i.total), status: i.status, paidAt: i.paid_at, remindersSent: i.reminders_sent,
});

/* ---------- N06: apply for a company account ---------- */

const applySchema = z.object({
  name: z.string({ error: 'Company name is required' }).trim().min(2, 'Company name is required').max(120),
  companiesHouseNo: z.string({ error: 'Companies House number is required' }).trim().regex(/^([0-9]{8}|[A-Z]{2}[0-9]{6})$/i, 'Enter the 8-character Companies House number, like 01234567'),
  billingAddress: z.string({ error: 'Billing address is required' }).trim().min(5, 'Billing address is required').max(300),
  financeContact: z.string({ error: 'Finance contact is required' }).trim().min(2, 'Finance contact is required').max(100),
  financeEmail: emailSchema,
  accountType: z.enum(['invoice', 'card']).default('invoice'),
  expectedSpend: z.coerce.number().min(0).max(1_000_000).optional(),
});

router.post(
  '/apply',
  ...customerOnly,
  body(applySchema),
  wrap(async (req, res) => {
    if (await membership(null, req.user.id)) throw new HttpError(409, 'You already belong to a company account.', 'already_member');
    const pending = await query("SELECT 1 FROM companies WHERE applied_by=$1 AND status='pending'", [req.user.id]);
    if (pending.rowCount) throw new HttpError(409, 'Your application is already waiting for a decision.', 'already_applied');
    const d = req.body;
    const c = await tx(async (db) => {
      let row;
      try {
        row = (await db.query(
          `INSERT INTO companies (name, companies_house_no, billing_address, finance_contact, finance_email, account_type, expected_spend, applied_by)
           VALUES ($1,upper($2),$3,$4,$5,$6,$7,$8) RETURNING *`,
          [d.name, d.companiesHouseNo, d.billingAddress, d.financeContact, d.financeEmail, d.accountType, d.expectedSpend ?? null, req.user.id],
        )).rows[0];
      } catch (e) {
        if (e.code === '23505') throw new HttpError(409, 'That company already has an account or an application.', 'duplicate', { companiesHouseNo: 'That company already has an account or an application' });
        throw e;
      }
      await sendEmail({ userId: req.user.id, to: req.user.email, kind: 'business_applied', subject: `We have your application for ${d.name}`, body: `Hello ${req.user.full_name},\n\nThank you for applying for a company account for ${d.name}. We check the company and reply within 2 working days.\n\nThe Private Hire Cars team` }, db);
      return row;
    });
    res.status(201).json({ company: serializeCompany(c) });
  }),
);

/** The customer's company (if any), their role, members, invoices and this month's spend. */
router.get(
  '/me',
  ...customerOnly,
  wrap(async (req, res) => {
    const m = await membership(null, req.user.id);
    if (!m) {
      const app = (await query('SELECT * FROM companies WHERE applied_by=$1 ORDER BY created_at DESC LIMIT 1', [req.user.id])).rows[0];
      return res.json({ company: null, application: app ? serializeCompany(app) : null });
    }
    const out = { company: serializeCompany(m), role: m.member_role, monthSpend: await monthSpend(null, m.id) };
    if (m.member_role === 'admin') {
      out.members = (await query(
        `SELECT m.id, m.member_role, m.active, m.added_at, u.full_name, u.email FROM company_members m JOIN users u ON u.id=m.customer_id
          WHERE m.company_id=$1 ORDER BY m.active DESC, m.member_role, u.full_name`, [m.id],
      )).rows.map((x) => ({ id: x.id, role: x.member_role, active: x.active, name: x.full_name, email: x.email, addedAt: x.added_at }));
      out.invites = (await query('SELECT email, expires_at FROM company_invites WHERE company_id=$1 AND accepted_at IS NULL AND expires_at > now()', [m.id])).rows;
      out.invoices = (await query('SELECT * FROM invoices WHERE company_id=$1 ORDER BY issued_at DESC', [m.id])).rows.map(serializeInvoice);
    }
    res.json(out);
  }),
);

async function requireCompanyAdmin(userId) {
  const m = await membership(null, userId);
  if (!m || m.member_role !== 'admin') throw new HttpError(403, 'Only the company account admin can do this.', 'not_company_admin');
  return m;
}

/* ---------- N08: invite and remove bookers ---------- */

router.post(
  '/members/invite',
  ...customerOnly,
  body(z.object({ email: emailSchema })),
  wrap(async (req, res) => {
    const m = await requireCompanyAdmin(req.user.id);
    if (!['approved', 'suspended'].includes(m.status)) throw new HttpError(409, 'Your company account is not active yet.', 'company_inactive');
    const out = await tx(async (db) => {
      const user = (await db.query("SELECT * FROM users WHERE email=$1 AND role='customer' AND is_active", [req.body.email])).rows[0];
      const token = crypto.randomBytes(24).toString('base64url');
      await db.query("INSERT INTO company_invites (token_hash, company_id, email, invited_by, expires_at) VALUES ($1,$2,$3,$4, now() + interval '7 days')", [sha(token), m.id, req.body.email, req.user.id]);
      const link = `${config.publicUrl}/business/join?token=${token}`;
      await sendEmail({
        userId: user?.id || null, to: req.body.email, kind: 'business_invite', sentBy: req.user.id,
        subject: `${req.user.full_name} invited you to book on ${m.name}'s account`,
        body: `Hello,\n\n${req.user.full_name} invited you to book Private Hire Cars journeys on the ${m.name} company account.\n\n${user ? 'Log in and accept here' : 'Create an account with this email address, then accept here'}: ${link}\n\nThe invitation works for 7 days.\n\nThe Private Hire Cars team`,
      }, db);
      await audit(db, req, 'business.invite', 'company', m.id, { email: req.body.email });
      return { invited: req.body.email, hasAccount: !!user };
    });
    res.status(201).json(out);
  }),
);

router.post(
  '/join',
  ...customerOnly,
  body(z.object({ token: z.string().min(20) })),
  wrap(async (req, res) => {
    const out = await tx(async (db) => {
      const inv = (await db.query('SELECT * FROM company_invites WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE', [sha(req.body.token)])).rows[0];
      if (!inv) throw new HttpError(400, 'This invitation is invalid or has expired. Ask for a new one.', 'bad_token');
      if (inv.email.toLowerCase() !== req.user.email.toLowerCase()) throw new HttpError(403, `This invitation is for ${inv.email}. Log in with that email.`, 'wrong_email');
      if (await membership(db, req.user.id)) throw new HttpError(409, 'You already book for a company account.', 'already_member');
      await db.query(
        `INSERT INTO company_members (company_id, customer_id, member_role) VALUES ($1,$2,'booker')
         ON CONFLICT (company_id, customer_id) DO UPDATE SET active=true, removed_at=NULL`,
        [inv.company_id, req.user.id],
      );
      await db.query('UPDATE company_invites SET accepted_at=now() WHERE token_hash=$1', [inv.token_hash]);
      return (await db.query('SELECT * FROM companies WHERE id=$1', [inv.company_id])).rows[0];
    });
    res.json({ company: serializeCompany(out), role: 'booker' });
  }),
);

router.delete(
  '/members/:id',
  ...customerOnly,
  wrap(async (req, res) => {
    const m = await requireCompanyAdmin(req.user.id);
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Member not found');
    const r = await query("UPDATE company_members SET active=false, removed_at=now() WHERE id=$1 AND company_id=$2 AND member_role='booker' RETURNING customer_id", [req.params.id, m.id]);
    if (!r.rowCount) throw notFound('Member not found');
    // Table 8: an employee leaves - their future company bookings go to the admin to decide.
    const future = (await query(
      "SELECT ref, pickup_at, total FROM bookings WHERE company_id=$1 AND customer_id=$2 AND status IN ('confirmed','assigned') AND pickup_at > now() ORDER BY pickup_at",
      [m.id, r.rows[0].customer_id],
    )).rows;
    await audit(null, req, 'business.remove_member', 'company', m.id, { member: req.params.id });
    res.json({ ok: true, futureBookings: future.map((b) => ({ ref: b.ref, pickupAt: b.pickup_at, total: Number(b.total) })) });
  }),
);

/** N12: all company bookings and spend (admin), newest first. */
router.get(
  '/bookings',
  ...customerOnly,
  wrap(async (req, res) => {
    const m = await requireCompanyAdmin(req.user.id);
    const { rows } = await query(
      `SELECT b.ref, b.pickup_at, b.pickup, b.destination, b.total, b.status, b.cost_centre, u.full_name AS booker,
              (SELECT i.number FROM invoice_lines l JOIN invoices i ON i.id=l.invoice_id WHERE l.booking_id=b.id) AS invoice
         FROM bookings b JOIN users u ON u.id=b.customer_id
        WHERE b.company_id=$1 ORDER BY b.pickup_at DESC LIMIT 300`,
      [m.id],
    );
    const spend = rows.filter((b) => !['cancelled', 'company_cancelled'].includes(b.status)).reduce((a, b) => a + Number(b.total), 0);
    res.json({
      bookings: rows.map((b) => ({ ref: b.ref, pickupAt: b.pickup_at, journey: `${b.pickup} to ${b.destination}`, total: Number(b.total), status: b.status, costCentre: b.cost_centre, booker: b.booker, invoice: b.invoice })),
      totalSpend: r2(spend),
      monthSpend: await monthSpend(null, m.id),
      creditLimit: m.credit_limit,
    });
  }),
);

/** N10: pay a company invoice (card, simulated). Paying reinstates a suspended account (Figure F5). */
router.post(
  '/invoices/:id/pay',
  ...customerOnly,
  body(z.object({ card: cardInputSchema })),
  wrap(async (req, res) => {
    const m = await requireCompanyAdmin(req.user.id);
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Invoice not found');
    const inv = (await query("SELECT * FROM invoices WHERE id=$1 AND company_id=$2", [req.params.id, m.id])).rows[0];
    if (!inv) throw notFound('Invoice not found');
    if (inv.status === 'paid') throw new HttpError(409, 'This invoice is already paid.', 'already_paid');
    const n = String(req.body.card.number).replace(/\D/g, '');
    const check = await visaCheck({ outcome: simOutcome(n), amount: Number(inv.total) });
    if (!check.approved) throw new HttpError(402, check.reason, 'payment_declined');
    await tx(async (db) => {
      await db.query("UPDATE invoices SET status='paid', paid_at=now() WHERE id=$1", [inv.id]);
      const left = await db.query("SELECT 1 FROM invoices WHERE company_id=$1 AND status='overdue' AND id<>$2", [m.id, inv.id]);
      if (m.status === 'suspended' && !left.rowCount) await db.query("UPDATE companies SET status='approved', status_reason=NULL WHERE id=$1", [m.id]);
      await sendEmail({ to: m.finance_email, kind: 'invoice_paid', subject: `Payment received - ${inv.number}`, body: `Thank you. We received GBP ${Number(inv.total).toFixed(2)} for invoice ${inv.number} by ${detectBrand(n)} ending ${n.slice(-4)} (ref ${check.ref}).` }, db);
      await audit(db, req, 'business.invoice_paid', 'invoice', inv.id, { number: inv.number });
    });
    res.json({ ok: true });
  }),
);

/* ---------- N07, N11: the Manager's queue ---------- */

staffRouter.get(
  '/companies',
  ...managerOnly,
  wrap(async (_req, res) => {
    const { rows } = await query(
      `SELECT c.*, u.full_name AS applicant, u.email AS applicant_email,
              (SELECT count(*)::int FROM company_members m WHERE m.company_id=c.id AND m.active) AS members,
              (SELECT COALESCE(sum(total),0) FROM invoices i WHERE i.company_id=c.id AND i.status IN ('open','overdue')) AS owed
         FROM companies c LEFT JOIN users u ON u.id=c.applied_by
        ORDER BY (c.status='pending') DESC, c.created_at DESC`,
    );
    res.json({ companies: rows.map((c) => ({ ...serializeCompany(c), applicant: c.applicant, applicantEmail: c.applicant_email, members: c.members, owed: Number(c.owed) })) });
  }),
);

const decide = (fn) =>
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Company not found');
    const c = await tx(async (db) => {
      const row = (await db.query('SELECT * FROM companies WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!row) throw notFound('Company not found');
      return fn(db, row, req);
    });
    res.json({ company: serializeCompany(c) });
  });

/** N07: approve with a credit limit; the applicant becomes the Business Account Admin. */
staffRouter.post(
  '/companies/:id/approve',
  ...managerOnly,
  body(z.object({ creditLimit: z.coerce.number({ error: 'Set a credit limit' }).min(50, 'At least GBP 50').max(100000) })),
  decide(async (db, c, req) => {
    if (c.status !== 'pending') throw new HttpError(409, 'Only a pending application can be approved.', 'bad_status');
    const { rows } = await db.query("UPDATE companies SET status='approved', credit_limit=$2, approved_by=$3, approved_at=now() WHERE id=$1 RETURNING *", [c.id, req.body.creditLimit, req.user.id]);
    await db.query("INSERT INTO company_members (company_id, customer_id, member_role) VALUES ($1,$2,'admin') ON CONFLICT (company_id, customer_id) DO UPDATE SET active=true, member_role='admin'", [c.id, c.applied_by]);
    const u = (await db.query('SELECT full_name, email FROM users WHERE id=$1', [c.applied_by])).rows[0];
    await sendEmail({ userId: c.applied_by, to: u.email, kind: 'business_approved', sentBy: req.user.id, subject: `${c.name} is approved`, body: `Hello ${u.full_name},\n\nYour company account for ${c.name} is approved with a monthly credit limit of GBP ${Number(req.body.creditLimit).toFixed(2)}. You are the account admin: invite your colleagues from the Business page. We invoice once a month; invoices are due in 15 days.\n\nThe Private Hire Cars team` }, db);
    await audit(db, req, 'business.approve', 'company', c.id, { creditLimit: req.body.creditLimit });
    return rows[0];
  }),
);

staffRouter.post(
  '/companies/:id/reject',
  ...managerOnly,
  body(z.object({ reason: z.string({ error: 'Give a reason' }).trim().min(5, 'Give a reason').max(300) })),
  decide(async (db, c, req) => {
    if (c.status !== 'pending') throw new HttpError(409, 'Only a pending application can be rejected.', 'bad_status');
    const { rows } = await db.query("UPDATE companies SET status='rejected', status_reason=$2 WHERE id=$1 RETURNING *", [c.id, req.body.reason]);
    const u = (await db.query('SELECT full_name, email FROM users WHERE id=$1', [c.applied_by])).rows[0];
    await sendEmail({ userId: c.applied_by, to: u.email, kind: 'business_rejected', sentBy: req.user.id, subject: `Your application for ${c.name}`, body: `Hello ${u.full_name},\n\nWe are sorry, we cannot open a company account for ${c.name}.\nReason: ${req.body.reason}\n\nYou can still book with a personal account.\n\nThe Private Hire Cars team` }, db);
    await audit(db, req, 'business.reject', 'company', c.id, { reason: req.body.reason });
    return rows[0];
  }),
);

staffRouter.post(
  '/companies/:id/status',
  ...managerOnly,
  body(z.object({ status: z.enum(['approved', 'suspended', 'closed']), reason: z.string().trim().max(300).optional(), creditLimit: z.coerce.number().min(50).max(100000).optional() })),
  decide(async (db, c, req) => {
    if (['pending', 'rejected'].includes(c.status)) throw new HttpError(409, 'Decide the application first.', 'bad_status');
    const { rows } = await db.query('UPDATE companies SET status=$2, status_reason=$3, credit_limit=COALESCE($4, credit_limit) WHERE id=$1 RETURNING *', [c.id, req.body.status, req.body.reason || null, req.body.creditLimit ?? null]);
    await audit(db, req, 'business.status', 'company', c.id, req.body);
    return rows[0];
  }),
);

/** N10: issue the invoice now (normally the monthly job does it on the 1st). */
staffRouter.post(
  '/companies/:id/invoice',
  ...managerOnly,
  wrap(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw notFound('Company not found');
    const inv = await tx(async (db) => {
      const c = (await db.query('SELECT * FROM companies WHERE id=$1', [req.params.id])).rows[0];
      if (!c) throw notFound('Company not found');
      const i = await issueInvoice(db, c, req.user);
      if (!i) throw badRequest('Nothing to invoice: there are no unbilled journeys on this account.');
      await audit(db, req, 'business.invoice', 'company', c.id, { number: i.number, total: i.total });
      return i;
    });
    res.status(201).json({ invoice: serializeInvoice(inv) });
  }),
);

/** N11: run the overdue check now (it also runs as a background job). */
staffRouter.post(
  '/companies/billing-check',
  ...managerOnly,
  wrap(async (_req, res) => res.json({ actions: await billingCheck() })),
);
