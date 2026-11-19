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
export const JOBS = {
  expireHolds: () => expireHolds(),
  reminders: () => sendReminders(),
  deliver: () => deliverQueued(),
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
