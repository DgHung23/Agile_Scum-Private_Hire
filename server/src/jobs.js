import { query } from './db.js';
import { expireHolds } from './services/availability.js';
import { deliverQueued, sendEmail, sendSms } from './services/notify.js';

const fmt = (d) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }).format(new Date(d));

/** N19: a reminder about 24 hours before the journey, by the customer's chosen channel (ID-43). */
export async function sendReminders() {
  const { rows } = await query(
    `UPDATE bookings b SET reminder_sent_at = now()
      WHERE b.status IN ('confirmed','assigned') AND b.reminder_sent_at IS NULL
        AND b.pickup_at BETWEEN now() + interval '23 hours' AND now() + interval '25 hours'
      RETURNING b.id, b.ref, b.pickup, b.destination, b.pickup_at, b.notify_pref, b.notify_phone, b.customer_id`,
  );
  for (const b of rows) {
    const u = (await query('SELECT full_name, email FROM users WHERE id=$1', [b.customer_id])).rows[0];
    const text = `Reminder: your Private Hire Cars journey ${b.ref} is tomorrow, ${fmt(b.pickup_at)}, from ${b.pickup} to ${b.destination}.`;
    if (['email', 'both'].includes(b.notify_pref)) {
      await sendEmail({ userId: b.customer_id, to: u.email, kind: 'reminder', bookingId: b.id, subject: `Reminder: your journey tomorrow - ${b.ref}`, body: `Hello ${u.full_name},\n\n${text}\n\nChanges are no longer possible online; call 020 7000 0000 if you need help.\n\nThe Private Hire Cars team` });
    }
    if (['text', 'both'].includes(b.notify_pref) && b.notify_phone) {
      await sendSms({ userId: b.customer_id, to: b.notify_phone, kind: 'reminder', bookingId: b.id, body: text });
    }
  }
  return rows.length;
}

/**
 * Background jobs (simulated scheduler). Each job is also safe to run on demand (Admin > Jobs, and the tests).
 * - every minute: release cabs held by unpaid bookings (ID-53), send 24-hour reminders (N19), deliver messages (ID-44)
 */
/**
 * N05 (TfL: records kept for at least 12 months; UK GDPR: no longer than needed): delete bookings, receipts, messages
 * and support records older than the retention period, and remove deleted customers' leftover rows.
 */
export async function retention() {
  const months = Number((await query("SELECT value FROM settings WHERE key='retention_months'")).rows[0]?.value || 12);
  const cut = `now() - make_interval(months => ${Math.max(12, Math.floor(months))})`;
  const del = async (sql) => (await query(sql)).rowCount;
  const out = {
    notifications: await del(`DELETE FROM notifications WHERE created_at < ${cut}`),
    loginAttempts: await del(`DELETE FROM login_attempts WHERE at < ${cut}`),
    sessions: await del(`DELETE FROM sessions WHERE created_at < ${cut}`),
    lostItems: await del(`DELETE FROM lost_items WHERE created_at < ${cut}`),
    complaints: await del(`DELETE FROM complaints WHERE created_at < ${cut}`),
    enquiries: await del(`DELETE FROM enquiries WHERE created_at < ${cut}`),
    bookings: await del(`DELETE FROM bookings WHERE end_at < ${cut}`), // receipts, events and reviews go with them
  };
  return Object.values(out).reduce((a, n) => a + n, 0);
}

export const JOBS = {
  expireHolds: () => expireHolds(),
  reminders: () => sendReminders(),
  deliver: () => deliverQueued(),
  retention: () => retention(),
};

export function startJobs() {
  const run = async () => {
    for (const [name, job] of Object.entries(JOBS)) {
      try {
        await job();
      } catch (e) {
        console.error(`[jobs] ${name} failed:`, e.message);
      }
    }
  };
  const timer = setInterval(run, 60_000);
  timer.unref();
  run();
  return timer;
}
