import crypto from 'node:crypto';
import { query as poolQuery } from '../db.js';
import { HttpError, badRequest } from '../errors.js';
import { findAvailableCabs, findAvailableDrivers } from './availability.js';
import {
  findAlternatives,
  getSettings,
  lockCabSize,
  loadBookingRow,
  modifiable,
  prepareJourney,
  priceFor,
  recordDiscounts,
  sizeProblems,
} from './booking.js';
import { sendEmail } from './notify.js';
import { describeMethod, refundPayment } from './payments.js';

const gbp = (n) => `GBP ${Number(n).toFixed(2)}`;
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const fmt = (d) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
  }).format(new Date(d));

async function netPaid(db, bookingId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN kind='charge' THEN amount ELSE -amount END), 0) AS net
       FROM payments WHERE booking_id=$1 AND status='approved'`,
    [bookingId],
  );
  return r2(Number(rows[0].net));
}

function assertChangeable(row, settings, { override }) {
  if (!['confirmed', 'assigned'].includes(row.status)) {
    throw new HttpError(409, `This booking is ${row.status.replace(/_/g, ' ')} and can no longer be changed.`, 'not_modifiable');
  }
  if (!override && !modifiable(row, settings.cancelWindowHours)) {
    throw new HttpError(
      409,
      `Bookings can only be cancelled or changed up to ${settings.cancelWindowHours} hours before pickup. Please call us on 020 7000 0000.`,
      'too_late',
    );
  }
}

/**
 * Cancel a booking and refund what was paid (US8.1). Customers are bound by the 24-hour window; staff may override.
 * The cab and driver are freed automatically because cancelled bookings are excluded from the overlap constraints.
 */
export async function cancelBooking(db, { id, actor, reason = null, override = false }) {
  const settings = await getSettings(db);
  const locked = await db.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE', [id]);
  if (!locked.rowCount) throw new HttpError(404, 'Booking not found', 'not_found');
  const row = await loadBookingRow(db, id);
  assertChangeable(row, settings, { override });

  const paid = await netPaid(db, id);
  await db.query('DELETE FROM coupon_redemptions WHERE booking_id=$1', [id]); // the coupon returns to the wallet (report Table 17)
  await db.query(
    `UPDATE bookings SET status='cancelled', cancelled_at=now(), cancel_reason=$2, driver_id=NULL, eta_minutes=NULL,
            payment_status=CASE WHEN $3::numeric > 0 THEN 'refunded' ELSE payment_status END, updated_at=now()
      WHERE id=$1`,
    [id, reason, paid],
  );
  const refund = await refundPayment(db, {
    bookingId: id,
    userId: row.customer_id,
    amount: paid,
    note: `Cancellation of ${row.ref}${actor.role !== 'customer' ? ' by staff' : ''}`,
  });

  const lines = [
    `Hello ${row.customer_name},`,
    '',
    `Your booking ${row.ref} has been cancelled.`,
    '',
    `Journey: ${row.pickup} to ${row.destination}`,
    `Was due: ${fmt(row.pickup_at)}`,
    '',
  ];
  if (refund) {
    lines.push(
      `A refund of ${gbp(refund.amount)} has been issued to ${describeMethod(refund)}.`,
      'It can take 3-5 working days to appear on your statement.',
    );
  } else lines.push('There was nothing to refund on this booking.');
  lines.push('', 'We hope to see you again soon.', '', 'The Private Hire Cars team');
  await sendEmail(
    { userId: row.customer_id, to: row.customer_email, subject: `Booking cancelled - ${row.ref}`, body: lines.join('\n'), kind: 'booking_cancelled', bookingId: id, sentBy: actor.role !== 'customer' ? actor.id : null },
    db,
  );
  return { booking: await loadBookingRow(db, id), refund, settings };
}

/**
 * Work out what an amendment would do: availability, new price and the difference (US8.2 criterion 2).
 * Does not change anything. `db` is a transaction client when called from amendBooking.
 */
export async function planAmendment(db, row, input, { override = false } = {}) {
  const settings = await getSettings(db);
  const j = await prepareJourney(
    db,
    {
      serviceCode: row.service_code, // the service type cannot be changed (docs/SPRINTS.md assumption 4)
      pickup: input.pickup,
      destination: input.destination,
      pickupAt: input.pickupAt,
      passengers: input.passengers,
      luggage: input.luggage ?? row.luggage,
      childSeatAges: row.child_seat_ages,
      pet: row.pet,
      accessibility: row.accessibility,
      passengerName: row.passenger_name,
      passengerPhone: row.passenger_phone,
      flightNo: row.flight_no,
      noteToDriver: row.note_to_driver,
      packageCode: input.packageCode ?? row.package_code ?? undefined,
      hours: row.package_code ? undefined : (input.hours ?? row.hours),
    },
    { settings, forAmend: true },
  );
  // ID-63: online, a booking cannot be moved into the next 24 hours either (red-team row 8).
  if (!override && j.pickupAt.getTime() - Date.now() < settings.cancelWindowHours * 3600_000) {
    throw badRequest('Please check the highlighted fields', {
      pickupAt: `Online changes must keep the pickup more than ${settings.cancelWindowHours} hours away. Please call us on 020 7000 0000.`,
    });
  }
  const run = db ? db.query.bind(db) : poolQuery;
  const sizes = (await run('SELECT * FROM cab_sizes ORDER BY sort')).rows;
  const size = sizes.find((s) => s.code === input.sizeCode);
  if (!size) throw badRequest('Choose a cab size', { sizeCode: 'Choose a cab size' });
  const misfit = sizeProblems(size, j);
  if (Object.keys(misfit).length) throw badRequest('That cab is too small', misfit);

  // An online booking keeps its online discount, and the same coupon amount, when amended.
  const quote = priceFor(settings, j, size, {
    channel: row.channel,
    couponAmount: Number(row.coupon_amount) || 0,
    couponLabel: row.offer_code ? `Coupon ${row.offer_code}` : undefined,
  });

  const wheelchair = (row.accessibility || []).includes('wheelchair');
  const free = await findAvailableCabs(db, { start: j.window.start, end: j.window.end, sizeCode: size.code, excludeBookingId: row.id, wheelchair });
  const keepCab = free.find((c) => c.id === row.cab_id) || null;
  const cab = keepCab || free[0] || null;
  const alternatives = cab ? null : await findAlternatives(db, j, sizes, size.code, settings);

  return {
    journey: j,
    size,
    quote,
    cab,
    keepsCab: !!keepCab,
    available: !!cab,
    alternatives,
    oldTotal: Number(row.total),
    newTotal: quote.total,
    difference: r2(quote.total - Number(row.total)),
    settings,
  };
}

/** Apply an amendment: re-check availability, reprice, settle the difference, update, email (US8.2). */
export async function amendBooking(db, { id, actor, input, override = false }) {
  const locked = await db.query('SELECT id FROM bookings WHERE id=$1 FOR UPDATE', [id]);
  if (!locked.rowCount) throw new HttpError(404, 'Booking not found', 'not_found');
  const row = await loadBookingRow(db, id);
  const settings = await getSettings(db);
  assertChangeable(row, settings, { override });
  await lockCabSize(db, input.sizeCode);
  const plan = await planAmendment(db, row, input, { override });
  if (!plan.available) {
    throw new HttpError(409, `No ${plan.size.label} is free at that time. Pick another time or a different cab size.`, 'no_availability').withExtra({
      alternatives: plan.alternatives,
    });
  }
  const j = plan.journey;

  // keep the assigned driver only if they are still free in the new window
  let driverId = row.driver_id;
  let status = row.status;
  let driverDropped = false;
  if (driverId) {
    const drivers = await findAvailableDrivers(db, { start: j.window.start, end: j.window.end, excludeBookingId: id });
    if (!drivers.find((d) => d.id === driverId)) {
      driverId = null;
      status = 'confirmed';
      driverDropped = true;
    }
  }

  await db.query(
    `UPDATE bookings SET pickup=$2, destination=$3, distance_miles=$4, hours=$5, pickup_at=$6, end_at=$7, passengers=$8,
            size_code=$9, cab_id=$10, driver_id=$11, status=$12, price_full=$13, discount_online=$14, discount_offer=$15,
            total=$16, surcharge_total=$17, price_lines=$18, luggage=$19, package_code=$20,
            amended_at=now(), amend_count=amend_count+1, updated_at=now()
      WHERE id=$1`,
    [
      id, j.pickup, j.destination, j.distance.miles, j.hours, j.pickupAt, j.window.end, j.passengers, plan.size.code,
      plan.cab.id, driverId, status, plan.quote.full, plan.quote.discountOnline, plan.quote.discountOffer, plan.quote.total,
      plan.quote.surcharge, JSON.stringify(plan.quote.lines), j.luggage, j.pkg?.code || null,
    ],
  );
  await recordDiscounts(db, id, plan.quote);

  // Settle the price difference against the original payment method (simulated)
  let settlement = null;
  if (plan.difference > 0) {
    const { rows: last } = await db.query(
      `SELECT * FROM payments WHERE booking_id=$1 AND kind='charge' AND status='approved' ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    if (last[0]) {
      const o = last[0];
      const ins = await db.query(
        `INSERT INTO payments (booking_id, user_id, kind, method, amount, status, card_brand, card_last4, paypal_payer, gateway_ref, note)
         VALUES ($1,$2,'charge',$3,$4,'approved',$5,$6,$7,$8,$9) RETURNING *`,
        [id, row.customer_id, o.method, plan.difference, o.card_brand, o.card_last4, o.paypal_payer,
          'AM-' + crypto.randomBytes(5).toString('hex').toUpperCase(), `Amendment of ${row.ref}`],
      );
      settlement = ins.rows[0];
    }
  } else if (plan.difference < 0) {
    settlement = await refundPayment(db, { bookingId: id, userId: row.customer_id, amount: Math.abs(plan.difference), note: `Amendment of ${row.ref}` });
  }
  await db.query(
    `UPDATE bookings SET payment_status = CASE WHEN (SELECT COALESCE(SUM(CASE WHEN kind='charge' THEN amount ELSE -amount END),0)
        FROM payments WHERE booking_id=$1 AND status='approved') > 0 THEN 'paid' ELSE payment_status END WHERE id=$1`,
    [id],
  );

  const updated = await loadBookingRow(db, id);
  const lines = [
    `Hello ${row.customer_name},`,
    '',
    `Your booking ${row.ref} has been updated.`,
    '',
    `Pickup: ${updated.pickup}`,
    `Destination: ${updated.destination}`,
    `When: ${fmt(updated.pickup_at)}`,
    `Passengers: ${updated.passengers}`,
    `Cab size: ${updated.size_label}`,
    '',
    `Previous total: ${gbp(plan.oldTotal)}`,
    `New total: ${gbp(plan.newTotal)}`,
  ];
  if (plan.difference > 0) lines.push(`Extra charged: ${gbp(plan.difference)}${settlement ? ` to ${describeMethod(settlement)}` : ''}`);
  if (plan.difference < 0) lines.push(`Refunded: ${gbp(Math.abs(plan.difference))}${settlement ? ` to ${describeMethod(settlement)}` : ''}`);
  if (driverDropped) lines.push('', 'Your driver will be re-assigned for the new time and we will let you know.');
  lines.push('', 'The Private Hire Cars team');
  await sendEmail(
    { userId: row.customer_id, to: row.customer_email, subject: `Booking updated - ${row.ref}`, body: lines.join('\n'), kind: 'booking_amended', bookingId: id, sentBy: actor.role !== 'customer' ? actor.id : null },
    db,
  );
  return { booking: updated, plan, settlement, settings, driverDropped };
}
