import { query } from '../db.js';
import { config } from '../config.js';

/**
 * Notification service (SIMULATED).
 * Email and SMS are written to the `notifications` outbox. To go live, call the real provider here and keep the insert
 * as an audit trail. `db` can be a transaction client so a message is only stored if the surrounding action commits.
 */
async function store(db, { userId = null, channel, to, subject = null, body, kind = 'general', bookingId = null, sentBy = null }) {
  const run = db ? db.query.bind(db) : query;
  const { rows } = await run(
    `INSERT INTO notifications (user_id, channel, to_addr, subject, body, kind, booking_id, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [userId, channel, to, subject, body, kind, bookingId, sentBy],
  );
  if (!config.isProd && config.env !== 'test') {
    console.log(`[notify:${channel}] -> ${to} :: ${subject || body.slice(0, 60)}`);
  }
  return rows[0];
}

export const sendEmail = (args, db) => store(db, { ...args, channel: 'email' });
export const sendSms = (args, db) => store(db, { ...args, channel: 'sms' });

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
