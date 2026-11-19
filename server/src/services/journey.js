import crypto from 'node:crypto';
import { HttpError, badRequest } from '../errors.js';
import { audit } from './audit.js';
import { findAvailableCabs, findAvailableDrivers } from './availability.js';
import { getSettings, loadBookingRow, prepareJourney, priceFor, recordDiscounts } from './booking.js';
import { sendEmail, sendSms } from './notify.js';
import { describeMethod, refundPayment } from './payments.js';
import { issueAndSend } from './receipts.js';

/*
 * Journey states after payment (report Figure 25):
 *   confirmed -> assigned -> on_route -> arrived -> in_progress -> completed
 *   arrived -> no_show (after 10 minutes of free waiting, N18)
 *   on_route / arrived / in_progress -> interrupted (N30) -> assigned (replacement car) or completed (customer stops)
 * Every change is stored as a status event with who made it (DoD line 9) and triggers the customer's messages (R6).
 */
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const gbp = (n) => `GBP ${Number(n).toFixed(2)}`;

const NEXT = {
  on_route: ['assigned', 'on_route'], // on_route again = a new ETA
  arrived: ['on_route'],
  in_progress: ['arrived'],
  completed: ['in_progress', 'interrupted'],
  no_show: ['arrived'],
  interrupted: ['on_route', 'arrived', 'in_progress'],
};
// Staff may correct the record (for example a journey finished while the app was offline).
const STAFF_EXTRA = { completed: ['assigned', 'on_route', 'arrived'], in_progress: ['on_route'] };

export async function recordEvent(db, bookingId, status, actor, reason = null, details = {}) {
  await db.query('INSERT INTO status_events (booking_id, status, reason, by_user, by_role, details) VALUES ($1,$2,$3,$4,$5,$6)', [
    bookingId, status, reason, actor?.id || null, actor?.role || null, details,
  ]);
}

/** The text sent when the driver is near (R6, ID-45). Includes registration, colour and make. */
export function arrivalSmsText(b, eta) {
  const first = (b.driver_name || 'Your driver').split(' ')[0];
  return `Private Hire: ${first} is about ${eta} min away. Look for a ${b.cab_colour} ${b.cab_make} ${b.cab_model}, reg ${b.cab_reg}. Booking ${b.ref}. Check the reg before you get in.`;
}

const textTo = (row) => row.notify_phone || row.passenger_phone || row.customer_phone;
const wantsText = (row) => ['text', 'both'].includes(row.notify_pref);
const wantsEmail = (row) => ['email', 'both'].includes(row.notify_pref);

async function tell(db, row, actor, { kind, sms, subject, email }) {
  const sent = [];
  if (sms && wantsText(row)) {
    const n = await sendSms({ userId: row.customer_id, to: textTo(row), body: sms, kind, bookingId: row.id, sentBy: actor?.id || null }, db);
    sent.push({ channel: 'sms', id: n.id, body: n.body });
  }
  if (email && (wantsEmail(row) || !wantsText(row) || !sms)) {
    const n = await sendEmail({ userId: row.customer_id, to: row.customer_email, kind, bookingId: row.id, sentBy: actor?.id || null, subject, body: `Hello ${row.customer_name},\n\n${email}\n\nThe Private Hire Cars team` }, db);
    sent.push({ channel: 'email', id: n.id });
  }
  return sent;
}

/**
 * Change the status of a booking. `actor` is the staff member or driver; `req` is used for the audit log.
 * Options: etaMinutes (on_route), reason (interrupted), cashCollected (completed, for cash bookings).
 */
export async function changeStatus(db, { id, to, actor, req, etaMinutes = null, reason = null, cashCollected = false, byDriver = false }) {
  const lock = await db.query('SELECT status FROM bookings WHERE id=$1 FOR UPDATE', [id]);
  if (!lock.rowCount) throw new HttpError(404, 'Booking not found', 'not_found');
  const row = await loadBookingRow(db, id);
  const allowed = [...(NEXT[to] || []), ...(!byDriver ? STAFF_EXTRA[to] || [] : [])];
  if (!allowed.includes(row.status)) {
    throw new HttpError(409, `A booking that is ${row.status.replace(/_/g, ' ')} cannot be set to ${to.replace(/_/g, ' ')}.`, 'bad_status');
  }
  if (!row.driver_id) throw new HttpError(409, 'Assign a driver first.', 'no_driver');
  const settings = await getSettings(db);
  const sent = [];

  if (to === 'on_route') {
    if (!etaMinutes) throw badRequest('Enter the ETA in minutes', { etaMinutes: 'Enter the ETA in minutes' });
    await db.query("UPDATE bookings SET status='on_route', eta_minutes=$2, updated_at=now() WHERE id=$1", [id, etaMinutes]);
    if (wantsText(row) && etaMinutes <= 15 && !row.arrival_sms_sent_at) {
      const n = await sendSms({ userId: row.customer_id, to: textTo(row), body: arrivalSmsText(row, etaMinutes), kind: 'driver_near', bookingId: row.id, sentBy: actor?.id || null }, db);
      await db.query('UPDATE bookings SET arrival_sms_sent_at=now() WHERE id=$1', [id]);
      sent.push({ channel: 'sms', id: n.id, body: n.body });
    }
    if (wantsEmail(row)) {
      const prev = await db.query("SELECT 1 FROM notifications WHERE booking_id=$1 AND kind='driver_on_route'", [id]);
      if (!prev.rowCount) {
        const n = await sendEmail({
          userId: row.customer_id, to: row.customer_email, kind: 'driver_on_route', bookingId: row.id, sentBy: actor?.id || null,
          subject: `Your driver is on the way - ${row.ref}`,
          body: `Hello ${row.customer_name},\n\nYour driver ${row.driver_name.split(' ')[0]} is on the way (about ${etaMinutes} minutes).\n\nCar: ${row.cab_colour} ${row.cab_make} ${row.cab_model}\nRegistration: ${row.cab_reg}\nDriver licence: ${row.driver_licence}\n\nPlease check the registration matches before you get in.\n\nThe Private Hire Cars team`,
        }, db);
        sent.push({ channel: 'email', id: n.id });
      }
    }
  } else if (to === 'arrived') {
    await db.query("UPDATE bookings SET status='arrived', arrived_at=now(), eta_minutes=NULL, updated_at=now() WHERE id=$1", [id]);
    sent.push(...(await tell(db, row, actor, {
      kind: 'driver_arrived',
      sms: `Private Hire: your driver has arrived in a ${row.cab_colour} ${row.cab_make}, reg ${row.cab_reg}. Free waiting: ${settings.noShowWaitMinutes || 10} minutes.`,
      subject: `Your driver has arrived - ${row.ref}`,
      email: `Your driver has arrived in a ${row.cab_colour} ${row.cab_make} ${row.cab_model}, registration ${row.cab_reg}. You have 10 minutes of free waiting.`,
    })));
  } else if (to === 'in_progress') {
    await db.query("UPDATE bookings SET status='in_progress', picked_up_at=now(), updated_at=now() WHERE id=$1", [id]);
  } else if (to === 'no_show') {
    const wait = Number((await db.query("SELECT value FROM settings WHERE key='no_show_wait_minutes'")).rows[0]?.value || 10);
    if (!row.arrived_at || Date.now() - new Date(row.arrived_at).getTime() < wait * 60_000) {
      throw new HttpError(409, `Wait ${wait} minutes after arriving before recording a no-show.`, 'too_early');
    }
    await db.query("UPDATE bookings SET status='no_show', updated_at=now() WHERE id=$1", [id]);
    await db.query('UPDATE assignments SET ended_at=now(), end_reason=$2 WHERE booking_id=$1 AND ended_at IS NULL', [id, 'no-show']);
    sent.push(...(await tell(db, row, actor, {
      kind: 'no_show',
      subject: `Missed pickup - ${row.ref}`,
      email: `Your driver waited ${wait} minutes at ${row.pickup} but could not find you, so booking ${row.ref} has been recorded as a no-show.\n\nAs our terms explain, the fare is not refunded for a no-show. If you think this is wrong, reply to this email or call 020 7000 0000.`,
    })));
  } else if (to === 'interrupted') {
    if (!reason) throw badRequest('Give a reason', { reason: 'Say why the journey cannot continue' });
    await db.query("UPDATE bookings SET status='interrupted', interrupted_reason=$2, updated_at=now() WHERE id=$1", [id, reason]);
    // The broken car is Unavailable until the Manager clears it (report Appendix G.2).
    await db.query("UPDATE cabs SET status='unavailable', status_reason=$2, updated_at=now() WHERE id=$1", [row.cab_id, `Journey ${row.ref} interrupted: ${reason}`]);
    await db.query("INSERT INTO incidents (booking_id, reported_by, kind, message) VALUES ($1,$2,'breakdown',$3)", [id, actor?.id || null, reason]);
    sent.push(...(await tell(db, row, actor, {
      kind: 'journey_interrupted',
      sms: `Private Hire: sorry, your car cannot continue (${reason}). We are sending a replacement now and will text its details. Your fare will not go up.`,
      subject: `Your journey was interrupted - ${row.ref}`,
      email: `We are sorry: your car cannot continue (${reason}). We are sending a replacement car and will text you its details. Your fare will not go up. If anyone is hurt, call 999.`,
    })));
  } else if (to === 'completed') {
    await db.query("UPDATE bookings SET status='completed', completed_at=now(), eta_minutes=NULL, updated_at=now() WHERE id=$1", [id]);
    await db.query('UPDATE assignments SET ended_at=now(), end_reason=$2 WHERE booking_id=$1 AND ended_at IS NULL', [id, 'completed']);
    if (row.payment_status === 'due_cash' && cashCollected) {
      // ID-56: cash paid to the driver at the end of the journey; the receipt follows.
      const { rows } = await db.query(
        `INSERT INTO payments (booking_id, user_id, kind, method, amount, status, gateway_ref, note, created_by, charge_kind)
         VALUES ($1,$2,'charge','cash',$3,'approved',$4,'Paid to the driver',$5,'fare') RETURNING *`,
        [id, row.customer_id, row.total, 'CA-' + crypto.randomBytes(5).toString('hex').toUpperCase(), actor?.id || null],
      );
      await db.query("UPDATE bookings SET payment_status='paid' WHERE id=$1", [id]);
      await issueAndSend(db, rows[0]);
    }
    const n = await sendEmail({
      userId: row.customer_id, to: row.customer_email, kind: 'journey_completed', bookingId: row.id, sentBy: actor?.id || null,
      subject: `How was your journey? - ${row.ref}`,
      body: `Hello ${row.customer_name},\n\nThank you for travelling with Private Hire Cars.\n\nPlease tell us how it went - rate your journey, the car and your driver from My trips.\n\nThe Private Hire Cars team`,
    }, db);
    sent.push({ channel: 'email', id: n.id });
  }

  await recordEvent(db, id, to, actor, reason, etaMinutes ? { etaMinutes } : {});
  if (req) await audit(db, req, `dispatch.status.${to}`, 'booking', id, { ref: row.ref, from: row.status, reason, byDriver });
  return { row: await loadBookingRow(db, id), sent };
}

/** ID-67: assign a free driver (and optionally another free cab). Expired documents block assignment (ID-65, ID-66). */
export async function assignDriver(db, { id, driverId, cabId = null, actor, req }) {
  const lock = await db.query('SELECT status FROM bookings WHERE id=$1 FOR UPDATE', [id]);
  if (!lock.rowCount) throw new HttpError(404, 'Booking not found', 'not_found');
  const row = await loadBookingRow(db, id);
  if (!['confirmed', 'assigned', 'interrupted'].includes(row.status)) {
    throw new HttpError(409, `A ${row.status.replace(/_/g, ' ')} booking cannot be assigned.`, 'bad_status');
  }
  const win = { start: row.pickup_at, end: row.end_at, excludeBookingId: row.id };
  const drivers = await findAvailableDrivers(db, win);
  if (!drivers.find((d) => d.id === driverId)) {
    throw new HttpError(409, 'That driver is not free for this journey, or a document has expired. Choose another driver.', 'driver_busy');
  }
  let newCab = row.cab_id;
  const replacing = row.status === 'interrupted';
  if (replacing && !cabId) throw badRequest('Choose a replacement car', { cabId: 'Choose a replacement car' });
  if (cabId && cabId !== row.cab_id) {
    const cabs = await findAvailableCabs(db, { ...win, wheelchair: (row.accessibility || []).includes('wheelchair') });
    const cab = cabs.find((c) => c.id === cabId);
    if (!cab) throw new HttpError(409, 'That cab is not free for this journey, or a document has expired.', 'cab_busy');
    if (cab.seats < row.passengers) throw badRequest('That cab is too small for the passengers', { cabId: 'Too small for the passengers' });
    if (replacing && cab.size_code !== row.size_code && cab.seats < row.size_seats) {
      throw badRequest('Send a car of the same size or bigger', { cabId: 'Send a car of the same size or bigger' });
    }
    newCab = cab.id;
  }
  await db.query('UPDATE assignments SET ended_at=now(), end_reason=$2 WHERE booking_id=$1 AND ended_at IS NULL', [id, replacing ? 'replaced after interruption' : 'reassigned']);
  // N30: the fare is never more than the original quote, whatever car is sent.
  await db.query(
    "UPDATE bookings SET driver_id=$2, cab_id=$3, status='assigned', dispatched_by=$4, eta_minutes=NULL, updated_at=now() WHERE id=$1",
    [id, driverId, newCab, actor.id],
  );
  await db.query('INSERT INTO assignments (booking_id, cab_id, driver_id, dispatched_by) VALUES ($1,$2,$3,$4)', [id, newCab, driverId, actor.id]);
  await recordEvent(db, id, 'assigned', actor, replacing ? 'replacement car' : null, { driverId, cabId: newCab });
  await audit(db, req, replacing ? 'dispatch.replace' : 'dispatch.assign', 'booking', id, { ref: row.ref, driverId, cabId: newCab });
  const updated = await loadBookingRow(db, id);
  let sent = [];
  if (replacing) {
    sent = await tell(db, updated, actor, {
      kind: 'replacement_car',
      sms: `Private Hire: your replacement car is a ${updated.cab_colour} ${updated.cab_make}, reg ${updated.cab_reg}, driven by ${updated.driver_name.split(' ')[0]}. Your fare is unchanged.`,
      subject: `Your replacement car - ${updated.ref}`,
      email: `Your replacement car is a ${updated.cab_colour} ${updated.cab_make} ${updated.cab_model}, registration ${updated.cab_reg}, driven by ${updated.driver_name.split(' ')[0]}. Your fare is unchanged.`,
    });
  }
  return { row: updated, sent };
}

/** ID-45: the driver is running late. More than 15 minutes late lets the customer cancel free of charge. */
export async function reportLate(db, { id, minutes, actor, req }) {
  const row = await loadBookingRow(db, id);
  if (!row || !['assigned', 'on_route'].includes(row.status)) throw new HttpError(409, 'Only a journey that has not started can be late.', 'bad_status');
  const limit = Number((await db.query("SELECT value FROM settings WHERE key='driver_late_minutes'")).rows[0]?.value || 15);
  await db.query('UPDATE bookings SET late_minutes=$2, late_sms_sent_at=now(), updated_at=now() WHERE id=$1', [id, minutes]);
  const free = minutes > limit ? ` As your driver is more than ${limit} minutes late, you can cancel free of charge from My trips.` : '';
  const sent = await tell(db, row, actor, {
    kind: 'driver_late',
    sms: `Private Hire: sorry, your driver is running about ${minutes} minutes late for ${row.ref}.${free}`,
    subject: `Your driver is running late - ${row.ref}`,
    email: `We are sorry: your driver is running about ${minutes} minutes late.${free}`,
  });
  await recordEvent(db, id, row.status, actor, `running ${minutes} minutes late`, { lateMinutes: minutes });
  if (req) await audit(db, req, 'dispatch.late', 'booking', id, { minutes });
  return { row: await loadBookingRow(db, id), sent };
}

/** Refunds given today on this booking by Call Centre Staff (the limit is per booking per day, red-team row 9). */
async function staffRefundsToday(db, bookingId) {
  const { rows } = await db.query(
    `SELECT COALESCE(sum(p.amount), 0) AS total FROM payments p JOIN users u ON u.id = p.created_by
      WHERE p.booking_id=$1 AND p.kind='refund' AND p.status='approved' AND u.role='staff'
        AND (p.created_at AT TIME ZONE 'Europe/London')::date = (now() AT TIME ZONE 'Europe/London')::date`,
    [bookingId],
  );
  return Number(rows[0].total);
}

export async function netPaid(db, bookingId) {
  const { rows } = await db.query(
    "SELECT COALESCE(SUM(CASE WHEN kind='charge' THEN amount ELSE -amount END), 0) AS net FROM payments WHERE booking_id=$1 AND status='approved'",
    [bookingId],
  );
  return r2(Number(rows[0].net));
}

/** N27: staff refund up to their limit per booking per day; the Manager can refund any amount. */
export async function staffRefund(db, { id, amount, reason, actor, req }) {
  const row = await loadBookingRow(db, id);
  if (!row) throw new HttpError(404, 'Booking not found', 'not_found');
  const paid = await netPaid(db, id);
  if (amount > paid) throw badRequest(`Only ${gbp(paid)} has been paid on this booking`, { amount: `At most ${gbp(paid)}` });
  if (actor.role === 'staff') {
    const limit = Number(actor.refund_limit ?? 50);
    const used = await staffRefundsToday(db, id);
    if (used + amount > limit + 0.001) {
      throw new HttpError(
        403,
        `Your refund limit is ${gbp(limit)} per booking per day and ${gbp(used)} has been refunded today. Ask a Manager to approve the rest.`,
        'over_refund_limit',
      ).withExtra({ limit, usedToday: used });
    }
  }
  const refund = await refundPayment(db, { bookingId: id, userId: row.customer_id, amount, note: reason });
  if (!refund) throw new HttpError(409, 'There is no payment to refund on this booking.', 'nothing_to_refund');
  await db.query('UPDATE payments SET reason=$2, created_by=$3, approved_by=$3 WHERE id=$1', [refund.id, reason, actor.id]);
  const left = await netPaid(db, id);
  await db.query('UPDATE bookings SET payment_status=$2 WHERE id=$1', [id, left > 0 ? 'partially_refunded' : 'refunded']);
  await issueAndSend(db, { ...refund, reason }); // credit note in the receipt history (FR-6.8)
  await sendEmail({
    userId: row.customer_id, to: row.customer_email, kind: 'refund', bookingId: id, sentBy: actor.id,
    subject: `Refund of ${gbp(amount)} - ${row.ref}`,
    body: `Hello ${row.customer_name},\n\nWe have refunded ${gbp(amount)} to ${describeMethod(refund)} for booking ${row.ref}.\nReason: ${reason}\n\nIt can take 3 to 5 working days to appear on your statement.\n\nThe Private Hire Cars team`,
  }, db);
  await recordEvent(db, id, row.status, actor, `refund ${gbp(amount)}: ${reason}`, { refund: amount });
  await audit(db, req, 'refund.create', 'booking', id, { amount, reason });
  return { refund, row: await loadBookingRow(db, id) };
}

/** N31 cleaning or damage charge, N18 late cancellation or no-show charge: charged to the original payment method. */
export async function extraCharge(db, { id, amount, kind, reason, actor, req }) {
  const row = await loadBookingRow(db, id);
  if (!row) throw new HttpError(404, 'Booking not found', 'not_found');
  const { rows: last } = await db.query(
    "SELECT * FROM payments WHERE booking_id=$1 AND kind='charge' AND status='approved' AND method IN ('card','paypal','bank') ORDER BY created_at DESC LIMIT 1",
    [id],
  );
  const o = last[0];
  if (!o) throw new HttpError(409, 'There is no card or account on this booking to charge. Ask the customer to pay in person.', 'no_payment_method');
  const { rows } = await db.query(
    `INSERT INTO payments (booking_id, user_id, kind, method, amount, status, card_brand, card_last4, paypal_payer, bank_name, gateway_ref, note, reason, created_by, charge_kind)
     VALUES ($1,$2,'charge',$3,$4,'approved',$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [id, row.customer_id, o.method, amount, o.card_brand, o.card_last4, o.paypal_payer, o.bank_name,
      'XC-' + crypto.randomBytes(5).toString('hex').toUpperCase(), `${kind.replace(/_/g, ' ')} charge`, reason, actor.id, kind],
  );
  await issueAndSend(db, rows[0]);
  await sendEmail({
    userId: row.customer_id, to: row.customer_email, kind: 'extra_charge', bookingId: id, sentBy: actor.id,
    subject: `Charge of ${gbp(amount)} - ${row.ref}`,
    body: `Hello ${row.customer_name},\n\nWe have charged ${gbp(amount)} to ${describeMethod(rows[0])} for booking ${row.ref}.\nReason: ${reason}\n\nIf you disagree, reply to this email or send us an enquiry about this trip within 14 days and we will review it.\n\nThe Private Hire Cars team`,
  }, db);
  await recordEvent(db, id, row.status, actor, `${kind} charge ${gbp(amount)}: ${reason}`, { charge: amount, kind });
  await audit(db, req, 'charge.create', 'booking', id, { amount, kind, reason });
  return { payment: rows[0], row: await loadBookingRow(db, id) };
}

/** N26: change the destination during the journey. The price is recalculated and the difference charged or refunded. */
export async function changeDestination(db, { id, destination, actor, req }) {
  const lock = await db.query('SELECT status FROM bookings WHERE id=$1 FOR UPDATE', [id]);
  if (!lock.rowCount) throw new HttpError(404, 'Booking not found', 'not_found');
  const row = await loadBookingRow(db, id);
  if (!['on_route', 'arrived', 'in_progress', 'interrupted', 'assigned'].includes(row.status)) {
    throw new HttpError(409, 'Use Amend for journeys that have not started.', 'bad_status');
  }
  const settings = await getSettings(db);
  const j = await prepareJourney(db, {
    serviceCode: row.service_code, pickup: row.pickup, destination, pickupAt: new Date(Date.now() + 3600_000).toISOString(),
    passengers: row.passengers, luggage: row.luggage, packageCode: row.package_code || undefined, hours: row.package_code ? undefined : row.hours,
  }, { settings, forAmend: true });
  const size = (await db.query('SELECT * FROM cab_sizes WHERE code=$1', [row.size_code])).rows[0];
  const quote = priceFor(settings, { ...j, night: false }, size, { channel: row.channel, couponAmount: Number(row.coupon_amount) || 0 });
  const difference = r2(quote.total - Number(row.total));
  await db.query(
    `UPDATE bookings SET destination=$2, distance_miles=$3, price_full=$4, discount_online=$5, discount_offer=$6, total=$7,
            surcharge_total=$8, price_lines=$9, updated_at=now() WHERE id=$1`,
    [id, j.destination, j.distance.miles, quote.full, quote.discountOnline, quote.discountOffer, quote.total, quote.surcharge, JSON.stringify(quote.lines)],
  );
  await recordDiscounts(db, id, quote);
  let settlement = null;
  if (difference > 0 && row.payment_status !== 'due_cash') {
    try {
      settlement = (await extraCharge(db, { id, amount: difference, kind: 'difference', reason: `New destination: ${j.destination}`, actor, req })).payment;
    } catch {
      settlement = null; // no card on file: the driver collects the difference
    }
  } else if (difference < 0 && row.payment_status !== 'due_cash') {
    settlement = await refundPayment(db, { bookingId: id, userId: row.customer_id, amount: Math.abs(difference), note: `New destination: ${j.destination}` });
    if (settlement) await issueAndSend(db, settlement);
  }
  await recordEvent(db, id, row.status, actor, `destination changed to ${j.destination}`, { difference });
  await audit(db, req, 'dispatch.destination', 'booking', id, { from: row.destination, to: j.destination, difference });
  return { row: await loadBookingRow(db, id), difference, settlement };
}
