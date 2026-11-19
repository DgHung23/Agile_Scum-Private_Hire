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
};
