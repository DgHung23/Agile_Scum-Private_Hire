import nodemailer from 'nodemailer';
import { onCommit, pool, query } from '../db.js';
import { config } from '../config.js';

/*
 * Notification service (ID-43 to ID-47, ID-44 delivery rules).
 * 1. The action is saved first; the message is written to the `notifications` outbox in the same transaction, as
 *    `queued`. If the action rolls back, no message is sent.
 * 2. After the commit the message is delivered: email over SMTP when SMTP_HOST is set (Mailpit in Docker, see
 *    docker-compose.yml), otherwise simulated. Texts are always simulated (a real build would call an SMS provider).
 * 3. A failed delivery is retried 3 times. Then it is marked `failed`, shown on the customer's notifications page and
 *    counted on the staff dashboard. A failed message never undoes the booking.
 * Test hooks: email to an address ending in "@fail.test" and texts to a number ending in "0000" always fail.
 */
const MAX_ATTEMPTS = 3;

async function store(db, { userId = null, channel, to, subject = null, body, kind = 'general', bookingId = null, sentBy = null, receiptId = null, attachmentName = null }) {
  const run = db ? db.query.bind(db) : query;
  const { rows } = await run(
    `INSERT INTO notifications (user_id, channel, to_addr, subject, body, kind, booking_id, sent_by, status, next_attempt_at, receipt_id, attachment_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',now(),$9,$10) RETURNING *`,
    [userId, channel, to, subject, body, kind, bookingId, sentBy, receiptId, attachmentName],
  );
  if (!config.isProd && config.env !== 'test') {
    console.log(`[notify:${channel}] -> ${to} :: ${subject || body.slice(0, 60)}`);
  }
  if (!db) scheduleDelivery();
  return rows[0];
}

export const sendEmail = (args, db) => store(db, { ...args, channel: 'email' });
export const sendSms = (args, db) => store(db, { ...args, channel: 'sms' });

let transport = null;
const smtp = () => {
  if (!config.smtpHost) return null;
  if (!transport) {
    transport = nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort, secure: false, ignoreTLS: true });
  }
  return transport;
};

/** One delivery attempt. Throws on failure. */
async function deliverOnce(n, attachments) {
  if (n.channel === 'email') {
    if (/@fail\.test$/i.test(n.to_addr)) throw new Error('Mailbox unavailable (test address)');
    const t = smtp();
    if (t) {
      await t.sendMail({ from: config.mailFrom, to: n.to_addr, subject: n.subject || '(no subject)', text: n.body, attachments });
    }
    return;
  }
  if (/0000$/.test(String(n.to_addr).replace(/\D/g, ''))) throw new Error('Phone number not reachable (test number)');
}

// Builds email attachments (for example the receipt PDF) at delivery time; registered by the receipts service.
let attachmentBuilder = async () => [];
export const setAttachmentBuilder = (fn) => {
  attachmentBuilder = fn;
};

/**
 * Deliver queued messages (ID-44): up to 3 attempts each, then `failed`.
 * Safe to run at any time and from several places (rows are claimed with SKIP LOCKED).
 */
export async function deliverQueued({ limit = 50 } = {}) {
  const client = await pool.connect();
  let done = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM notifications WHERE status IN ('queued','retrying') AND COALESCE(next_attempt_at, now()) <= now()
        ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    for (const n of rows) {
      let attempts = n.attempts;
      let error = null;
      const attachments = n.receipt_id ? await attachmentBuilder(n) : [];
      while (attempts < MAX_ATTEMPTS) {
        attempts++;
        try {
          await deliverOnce(n, attachments);
          error = null;
          break;
        } catch (e) {
          error = e.message;
          if (attempts < MAX_ATTEMPTS && config.env !== 'test') await new Promise((r) => setTimeout(r, 200 * attempts));
        }
      }
      await client.query(
        `UPDATE notifications SET attempts=$2, status=$3, last_error=$4, delivered_at=CASE WHEN $3='sent' THEN now() END,
                next_attempt_at=NULL WHERE id=$1`,
        [n.id, attempts, error ? 'failed' : 'sent', error],
      );
      done++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return done;
}

let timer = null;
let autoDelivery = config.env !== 'test';
/** Command-line scripts (seeding) stop automatic delivery before closing the database pool. */
export function stopAutoDelivery() {
  autoDelivery = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
/** Deliver soon after the current transaction commits (not during tests, which call deliverQueued themselves). */
export function scheduleDelivery() {
  if (!autoDelivery || timer) return;
  timer = setTimeout(() => {
    timer = null;
    deliverQueued().catch((e) => console.error('[notify] delivery failed:', e.message));
  }, 150);
}
onCommit(scheduleDelivery);

export const loginUrl = () => `${config.publicUrl}/login`;

/* ---- message templates ---- */
export const templates = {
  welcome: (user) => ({
    subject: 'Welcome to Private Hire Cars - your account is ready',
    body:
      `Hello ${user.full_name},\n\n` +
      'Thank you for registering with Private Hire Cars. Your account has been created.\n\n' +
      'Before your first booking, please verify your email address with the link in our separate email.\n\n' +
      `Log in to book your first journey: ${loginUrl()}\n\n` +
      'Remember: every booking you make online is 15% cheaper, and online customers get priority service.\n\n' +
      'The Private Hire Cars team',
  }),
  accountCreatedByStaff: (user) => ({
    subject: 'Your Private Hire Cars account has been created',
    body:
      `Hello ${user.full_name},\n\n` +
      'As requested on your call, we have created a Private Hire Cars account for you.\n' +
      `Use "Forgot password" at ${loginUrl()} to choose your own password and start booking online with 15% off.\n\n` +
      'The Private Hire Cars team',
  }),
  verifyEmail: (user, link) => ({
    subject: 'Verify your email address',
    body:
      `Hello ${user.full_name},\n\n` +
      'Please confirm this is your email address so you can book online:\n\n' +
      `${link}\n\n` +
      'The link works for 48 hours. If you did not create an account, you can ignore this email.\n\n' +
      'The Private Hire Cars team',
  }),
  registerAttempt: (user) => ({
    subject: 'Someone tried to register with your email',
    body:
      `Hello ${user.full_name},\n\n` +
      'Someone just tried to create a Private Hire Cars account with this email address, which already has an account.\n\n' +
      `If it was you, log in at ${loginUrl()} or use "Forgot password". If it was not you, no action is needed.\n\n` +
      'The Private Hire Cars team',
  }),
  accountLocked: (user, link, minutes) => ({
    subject: 'We paused sign-ins to your account',
    body:
      `Hello ${user.full_name},\n\n` +
      `There were several failed attempts to log in to your account, so we have paused sign-ins from that device for ${minutes} minutes.\n\n` +
      `If it was you, unlock your account now: ${link}\n\n` +
      'If it was not you, we recommend you change your password.\n\n' +
      'The Private Hire Cars team',
  }),
  emailChanged: (user, newEmail) => ({
    subject: 'Your email address was changed',
    body:
      `Hello ${user.full_name},\n\n` +
      `The email address on your Private Hire Cars account was changed to ${newEmail}.\n\n` +
      'If you did not make this change, call us straight away on 020 7000 0000.\n\n' +
      'The Private Hire Cars team',
  }),
  passwordChanged: (user) => ({
    subject: 'Your Private Hire Cars password was changed',
    body:
      `Hello ${user.full_name},\n\n` +
      'Your password has just been changed and other devices were signed out. If this was not you, contact us straight away on 020 7000 0000.\n\n' +
      'The Private Hire Cars team',
  }),
  passwordReset: (user, link) => ({
    subject: 'Reset your Private Hire Cars password',
    body:
      `Hello ${user.full_name},\n\n` +
      `We received a request to reset your password. Use this link within 1 hour:\n\n${link}\n\n` +
      'If you did not ask for this you can ignore this email - your password has not changed.\n\n' +
      'The Private Hire Cars team',
  }),
};
