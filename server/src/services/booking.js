import crypto from 'node:crypto';
import { query } from '../db.js';
import { badRequest, HttpError } from '../errors.js';
import { bookingWindow, findAvailableCabs } from './availability.js';
import { computeQuote, estimateDistance, estimateDuration } from './pricing.js';
import { sendEmail } from './notify.js';
import { createSavedCard, describeMethod, takePayment } from './payments.js';

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const MIN_LEAD_MINUTES = 10;

export const newRef = () =>
  'PH-' + Array.from(crypto.randomBytes(6), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');

export async function getSettings(db) {
  const run = db ? db.query.bind(db) : query;
  const { rows } = await run('SELECT key, value FROM settings');
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    onlineDiscountPct: Number(s.online_discount_pct ?? 15),
    cancelWindowHours: Number(s.cancel_window_hours ?? 24),
  };
}

const svc = (s) => ({
  code: s.code,
  label: s.label,
  baseFare: s.base_fare,
  perMile: s.per_mile,
  hourlyRate: s.hourly_rate,
  extraFee: s.extra_fee,
  minFare: s.min_fare,
  minHours: s.min_hours,
  maxHours: s.max_hours,
  isHourly: s.is_hourly,
  needsAirport: s.needs_airport,
});

/**
 * Validate a journey request and work out distance, duration and the time window it occupies.
 * Shared by the quote endpoint and booking creation so both apply exactly the same rules.
 * Throws HttpError(400) with per-field messages (US3.1-3.3, US5.2).
 */
export async function prepareJourney(db, input, { now = new Date() } = {}) {
  const run = db ? db.query.bind(db) : query;
  const errors = {};

  const sRes = await run('SELECT * FROM services WHERE code = $1 AND active', [input.serviceCode || '']);
  if (!sRes.rowCount) errors.serviceCode = 'Choose a service to continue';
  const service = sRes.rowCount ? svc(sRes.rows[0]) : null;

  const pickup = (input.pickup || '').trim();
  let destination = (input.destination || '').trim();
  if (!pickup) errors.pickup = 'Pickup location is required';
  if (service?.isHourly) {
    if (!destination) destination = 'Return to pickup location';
  } else {
    if (!destination) errors.destination = 'Destination is required';
    else if (pickup && pickup.toLowerCase() === destination.toLowerCase()) {
      errors.destination = 'Pickup and destination cannot be the same place';
    }
  }

  const pickupAt = new Date(input.pickupAt);
  if (Number.isNaN(pickupAt.getTime())) errors.pickupAt = 'Choose a date and time';
  else if (pickupAt.getTime() < now.getTime() + MIN_LEAD_MINUTES * 60_000) {
    errors.pickupAt = 'Choose a date and time in the future';
  }

  const passengers = Number(input.passengers);
  if (!Number.isInteger(passengers) || passengers < 1) errors.passengers = 'Enter at least 1 passenger';

  let hours = null;
  if (service?.isHourly) {
    hours = Number(input.hours);
    if (!Number.isInteger(hours) || hours < service.minHours || hours > service.maxHours) {
      errors.hours = `Choose between ${service.minHours} and ${service.maxHours} hours`;
    }
  }

  const locations = (await run('SELECT name, kind, lat, lng FROM locations')).rows.map((l) => ({
    ...l,
    lat: Number(l.lat),
    lng: Number(l.lng),
  }));

  if (service?.needsAirport && pickup && destination && !errors.destination) {
    const airports = new Set(locations.filter((l) => l.kind === 'airport').map((l) => l.name.toLowerCase()));
    if (!airports.has(pickup.toLowerCase()) && !airports.has(destination.toLowerCase())) {
      errors.destination = `${service.label} needs an airport as the pickup or the destination`;
    }
  }

  if (Object.keys(errors).length) throw badRequest('Please check the highlighted fields', errors);

  const distance = service.isHourly
    ? { miles: 0, source: 'hourly' }
    : estimateDistance(pickup, destination, locations, { longDistance: service.code === 'long_distance' });
  const durationMinutes = estimateDuration({ miles: distance.miles, hours, isHourly: service.isHourly });
  const window = bookingWindow(pickupAt, durationMinutes);

  return { service, pickup, destination, pickupAt, passengers, hours, distance, durationMinutes, window };
}

/** Alternatives offered when nothing is free (US5.1 criterion 1): other sizes now, or other start times. */
export async function findAlternatives(db, j, sizes, sizeCode) {
  const sizeOptions = [];
  const free = await findAvailableCabs(db, { start: j.window.start, end: j.window.end });
  const counts = {};
  for (const c of free) counts[c.size_code] = (counts[c.size_code] || 0) + 1;
  for (const s of sizes) {
    if (s.code !== sizeCode && s.seats >= j.passengers && counts[s.code]) {
      sizeOptions.push({ code: s.code, label: s.label, available: counts[s.code] });
    }
  }
  const times = [];
  for (const offset of [-60, -30, 30, 60, 90, 120, 180, 240]) {
    const start = new Date(j.pickupAt.getTime() + offset * 60_000);
    if (start.getTime() < Date.now() + MIN_LEAD_MINUTES * 60_000) continue;
    const w = bookingWindow(start, j.durationMinutes);
    const cabs = await findAvailableCabs(db, { start: w.start, end: w.end, sizeCode });
    if (cabs.length) times.push(start.toISOString());
    if (times.length >= 4) break;
  }
  return { sizes: sizeOptions, times };
}

export async function loadBookingRow(db, id) {
  const run = db ? db.query.bind(db) : query;
  const { rows } = await run(
    `SELECT b.*, s.label AS service_label, z.label AS size_label, z.seats AS size_seats,
            c.reg AS cab_reg, c.make AS cab_make, c.model AS cab_model, c.colour AS cab_colour,
            d.full_name AS driver_name, d.phone AS driver_phone,
            u.full_name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
       FROM bookings b
       JOIN services s ON s.code = b.service_code
       JOIN cab_sizes z ON z.code = b.size_code
       JOIN cabs c ON c.id = b.cab_id
       LEFT JOIN drivers d ON d.id = b.driver_id
       JOIN users u ON u.id = b.customer_id
      WHERE b.id = $1`,
    [id],
  );
  return rows[0] || null;
}

/** Customers may change/cancel until `cancelWindowHours` before pickup (R10). */
export function modifiable(row, cancelWindowHours, now = new Date()) {
  if (!['confirmed', 'assigned'].includes(row.status)) return false;
  return new Date(row.pickup_at).getTime() - now.getTime() >= cancelWindowHours * 3600_000;
}

export function serializeBooking(row, { cancelWindowHours = 24, forStaff = false } = {}) {
  const showVehicle = forStaff || ['assigned', 'on_route', 'completed'].includes(row.status);
  return {
    id: row.id,
    ref: row.ref,
    status: row.status,
    service: { code: row.service_code, label: row.service_label },
    pickup: row.pickup,
    destination: row.destination,
    distanceMiles: row.distance_miles,
    hours: row.hours,
    pickupAt: row.pickup_at,
    endAt: row.end_at,
    passengers: row.passengers,
    size: { code: row.size_code, label: row.size_label, seats: row.size_seats },
    channel: row.channel,
    priority: row.priority,
    notifyPref: row.notify_pref,
    notifyPhone: row.notify_phone,
    price: {
      full: row.price_full,
      discountOnline: row.discount_online,
      discountOffer: row.discount_offer,
      offerCode: row.offer_code,
      total: row.total,
    },
    vehicle: showVehicle
      ? { reg: row.cab_reg, make: row.cab_make, model: row.cab_model, colour: row.cab_colour }
      : null,
    driver: showVehicle && row.driver_name ? { name: row.driver_name, ...(forStaff ? { phone: row.driver_phone } : {}) } : null,
    etaMinutes: row.eta_minutes,
    paymentStatus: row.payment_status ?? null,
    modifiable: modifiable(row, cancelWindowHours),
    cancelDeadline: new Date(new Date(row.pickup_at).getTime() - cancelWindowHours * 3600_000).toISOString(),
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    ...(forStaff
      ? {
          customer: { id: row.customer_id, name: row.customer_name, email: row.customer_email, phone: row.customer_phone },
          cabId: row.cab_id,
          driverId: row.driver_id,
          notes: row.notes,
        }
      : {}),
  };
}

const fmt = (d) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
  }).format(new Date(d));
const gbp = (n) => `GBP ${Number(n).toFixed(2)}`;

export function bookingConfirmationEmail(row, customerName, paidWith = null) {
  const lines = [
    `Hello ${customerName},`,
    '',
    'Your PrivateHire Cars booking is confirmed.',
    '',
    `Booking reference: ${row.ref}`,
    `Service: ${row.service_label}`,
    `Pickup: ${row.pickup}`,
    `Destination: ${row.destination}`,
    `When: ${fmt(row.pickup_at)}`,
    `Passengers: ${row.passengers}`,
    `Cab size: ${row.size_label}`,
    '',
    `Full price: ${gbp(row.price_full)}`,
  ];
  if (row.discount_online > 0) lines.push(`Online discount: -${gbp(row.discount_online)}`);
  if (row.discount_offer > 0) lines.push(`Offer ${row.offer_code}: -${gbp(row.discount_offer)}`);
  lines.push(`Total: ${gbp(row.total)}`);
  if (paidWith) lines.push(`Paid with: ${paidWith}`);
  lines.push('');
  if (['text', 'both'].includes(row.notify_pref)) {
    lines.push(`About 10-15 minutes before arrival we will text ${row.notify_phone} with your car's registration, colour and make.`, '');
  }
  lines.push(
    'You can cancel or change this booking free of charge up to 24 hours before pickup from My trips.',
    '',
    'The PrivateHire Cars team',
  );
  return { subject: `Booking confirmed - ${row.ref}`, body: lines.join('\n') };
}

export const lockCabSize = (db, sizeCode) =>
  db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['booking-size:' + sizeCode]);

/**
 * Create a booking inside a transaction: validate, find a free cab, price it, insert, send the confirmation.
 * The database exclusion constraint is the final guard against double booking; if a parallel request takes the
 * cab first we simply try the next free cab (US5.1).
 */
export async function createBooking(db, { customer, input, channel, createdBy = null, extra = {}, payment = null }) {
  const settings = await getSettings(db);
  const j = await prepareJourney(db, input);

  const sizes = (await db.query('SELECT * FROM cab_sizes ORDER BY sort')).rows;
  const size = sizes.find((s) => s.code === input.sizeCode);
  if (!size) throw badRequest('Choose a cab size', { sizeCode: 'Choose a cab size' });
  if (j.passengers > size.seats) {
    throw badRequest('Too many passengers for that cab', {
      passengers: `${size.label} carries up to ${size.seats} passengers. Choose a bigger cab or fewer passengers.`,
      sizeCode: 'Choose a bigger cab',
    });
  }

  const quote = computeQuote({
    service: j.service,
    size: { ...size, multiplier: Number(size.multiplier) },
    miles: j.distance.miles,
    hours: j.hours,
    channel,
    onlineDiscountPct: settings.onlineDiscountPct,
    offerPct: extra.offerPct || 0,
  });

  // Serialise concurrent bookings of the same cab size (held until this transaction ends). Without this, two
  // requests inserting overlapping rows for different cabs can deadlock on the exclusion constraint.
  await lockCabSize(db, size.code);
  const candidates = await findAvailableCabs(db, { start: j.window.start, end: j.window.end, sizeCode: size.code });
  const notifyPref = input.notifyPref || customer.notify_pref || 'email';

  let inserted = null;
  for (const cab of candidates) {
    await db.query('SAVEPOINT try_cab');
    try {
      const { rows } = await db.query(
        `INSERT INTO bookings (ref, customer_id, service_code, pickup, destination, distance_miles, hours, pickup_at, end_at,
                               passengers, size_code, cab_id, channel, priority, notify_pref, notify_phone,
                               price_full, discount_online, discount_offer, offer_code, total, created_by, notes, offer_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id`,
        [
          newRef(), customer.id, j.service.code, j.pickup, j.destination, j.distance.miles, j.hours, j.pickupAt,
          j.window.end, j.passengers, size.code, cab.id, channel, channel === 'online', notifyPref,
          ['text', 'both'].includes(notifyPref) ? customer.phone : null,
          quote.full, quote.discountOnline, quote.discountOffer, extra.offerCode || null, quote.total, createdBy,
          input.notes || null, extra.offerPct || 0,
        ],
      );
      await db.query('RELEASE SAVEPOINT try_cab');
      inserted = rows[0].id;
      break;
    } catch (e) {
      await db.query('ROLLBACK TO SAVEPOINT try_cab');
      if (e.code !== '23P01') throw e;
    }
  }

  if (!inserted) {
    const alternatives = await findAlternatives(db, j, sizes, size.code);
    throw new HttpError(
      409,
      `No ${size.label} is free at that time. Pick another time or a different cab size.`,
      'no_availability',
      undefined,
    ).withExtra({ alternatives });
  }

  // US5.3: take payment inside the same transaction. A decline throws 402 and the booking is rolled back.
  let paymentRow = null;
  if (payment) {
    paymentRow = await takePayment(db, { userId: customer.id, bookingId: inserted, amount: quote.total, payment });
    await db.query("UPDATE bookings SET payment_status='paid' WHERE id=$1", [inserted]);
    if (payment.method === 'card' && payment.card && payment.saveCard) {
      await createSavedCard(db, customer.id, payment.card);
    }
  }

  const row = await loadBookingRow(db, inserted);
  const mail = bookingConfirmationEmail(row, customer.full_name, paymentRow ? describeMethod(paymentRow) : null);
  await sendEmail({ userId: customer.id, to: customer.email, kind: 'booking_confirmed', bookingId: row.id, ...mail }, db);
  return { row, quote, settings, payment: paymentRow };
}
