import crypto from 'node:crypto';
import { query } from '../db.js';
import { badRequest, HttpError } from '../errors.js';
import { bookingWindow, expireHolds, findAvailableCabs } from './availability.js';
import { computeQuote, estimateDistance, estimateDuration, inCentralZone, isNight } from './pricing.js';
import { sendEmail } from './notify.js';
import { resolveCoupon } from './offers.js';

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ACCESSIBILITY = ['wheelchair', 'assistance_dog', 'help_find_car'];
export const ACCESSIBILITY_LABEL = {
  wheelchair: 'Wheelchair-accessible vehicle',
  assistance_dog: 'Travelling with an assistance dog',
  help_find_car: 'Help to find the car',
};

/** Random booking references (ID-33, ID-59: references cannot be guessed). */
export const newRef = () =>
  'PH-' + Array.from(crypto.randomBytes(6), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');

export async function getSettings(db) {
  const run = db ? db.query.bind(db) : query;
  const { rows } = await run('SELECT key, value FROM settings');
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const n = (k, d) => (Number.isFinite(Number(s[k])) ? Number(s[k]) : d);
  return {
    onlineDiscountPct: n('online_discount_pct', 15),
    cancelWindowHours: n('cancel_window_hours', 24),
    minFare: n('min_fare_gbp', 5),
    holdMinutes: n('hold_minutes', 15),
    maxDaysAhead: n('max_days_ahead', 90),
    minLeadMinutes: n('min_lead_minutes', 30),
    surcharges: { nightPct: n('night_surcharge_pct', 20), zoneFee: n('zone_surcharge_gbp', 2.5), weatherPct: n('weather_surcharge_pct', 0) },
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

const PHONE = /^\+?[0-9 ()-]{7,20}$/;
const FLIGHT = /^[A-Z0-9]{2,3}\s?\d{1,4}[A-Z]?$/i;

/** ID-40: "as soon as possible" is the earliest allowed pickup, rounded up to the next 5 minutes. */
export function asapTime(now, leadMinutes) {
  const step = 5 * 60_000;
  return new Date(Math.ceil((now.getTime() + leadMinutes * 60_000) / step) * step);
}

/**
 * Validate a journey request and work out distance, duration and the time window it occupies.
 * Shared by quotes, bookings and amendments so all apply exactly the same rules (ID-29, ID-30, ID-39, ID-75).
 * Throws HttpError(400) with per-field messages.
 */
export async function prepareJourney(db, input, { now = new Date(), settings = null, forAmend = false } = {}) {
  const run = db ? db.query.bind(db) : query;
  const cfg = settings || (await getSettings(db));
  const errors = {};

  const sRes = await run('SELECT * FROM services WHERE code = $1 AND active', [input.serviceCode || '']);
  if (!sRes.rowCount) errors.serviceCode = 'Choose a service to continue';
  const service = sRes.rowCount ? svc(sRes.rows[0]) : null;

  const pickup = (input.pickup || '').trim();
  let destination = (input.destination || '').trim();
  if (!pickup) errors.pickup = 'Pickup location is required';
  if (service?.isHourly) {
    if (!destination) destination = 'Return to pickup location';
  } else if (!destination) errors.destination = 'Destination is required';
  else if (pickup && pickup.toLowerCase() === destination.toLowerCase()) {
    errors.destination = 'Pickup and destination cannot be the same place';
  }

  // ID-29: at least 30 minutes ahead, at most 90 days ahead. ID-40: or as soon as possible.
  const asap = !!input.asap && !forAmend;
  const pickupAt = asap ? asapTime(now, cfg.minLeadMinutes) : new Date(input.pickupAt);
  if (Number.isNaN(pickupAt.getTime())) errors.pickupAt = 'Choose a date and time';
  else if (pickupAt.getTime() < now.getTime() + cfg.minLeadMinutes * 60_000 - 1000) {
    errors.pickupAt = `Choose a pickup at least ${cfg.minLeadMinutes} minutes from now`;
  } else if (pickupAt.getTime() > now.getTime() + cfg.maxDaysAhead * 86_400_000) {
    errors.pickupAt = `You can book up to ${cfg.maxDaysAhead} days ahead`;
  }

  // ID-30: 1 to 8 passengers, luggage, child seats (one age per seat), pet.
  const passengers = Number(input.passengers);
  if (!Number.isInteger(passengers) || passengers < 1) errors.passengers = 'Enter at least 1 passenger';
  else if (passengers > 8) errors.passengers = 'We carry up to 8 passengers in one cab. For more, please book two cabs or call us.';
  const luggage = input.luggage === undefined || input.luggage === '' ? 0 : Number(input.luggage);
  if (!Number.isInteger(luggage) || luggage < 0 || luggage > 12) errors.luggage = 'Enter 0 to 12 bags';
  const childSeatAges = Array.isArray(input.childSeatAges) ? input.childSeatAges.map(Number) : [];
  if (childSeatAges.length > 3) errors.childSeatAges = 'We can fit up to 3 child seats';
  else if (childSeatAges.some((a) => !Number.isInteger(a) || a < 0 || a > 11)) errors.childSeatAges = 'Child seat ages must be 0 to 11 years';
  else if (Number.isInteger(passengers) && childSeatAges.length >= passengers) {
    errors.childSeatAges = 'Children count as passengers, and an adult must travel too. Add the children to the passengers.';
  }
  const pet = !!input.pet;

  // ID-39: accessibility requests, never charged.
  const accessibility = Array.isArray(input.accessibility) ? [...new Set(input.accessibility)] : [];
  if (accessibility.some((a) => !ACCESSIBILITY.includes(a))) errors.accessibility = 'Choose from the listed options';

  // ID-38: booking for someone else - their phone gets the texts.
  const passengerName = (input.passengerName || '').trim() || null;
  const passengerPhone = (input.passengerPhone || '').trim() || null;
  if (passengerName && !passengerPhone) errors.passengerPhone = "Enter the passenger's phone so the driver can reach them";
  if (passengerPhone && !PHONE.test(passengerPhone)) errors.passengerPhone = 'Enter a valid telephone number, like 07700 900123';
  if (passengerPhone && !passengerName) errors.passengerName = "Enter the passenger's name";

  // ID-41: flight number for airport pickups.
  const flightNo = (input.flightNo || '').trim().toUpperCase() || null;
  if (flightNo && !FLIGHT.test(flightNo)) errors.flightNo = 'Enter a flight number like BA 117';
  const noteToDriver = (input.noteToDriver || '').trim() || null;
  if (noteToDriver && noteToDriver.length > 300) errors.noteToDriver = 'Keep the note under 300 characters';

  // ID-75: daily hire is booked as a package.
  let hours = null;
  let pkg = null;
  if (service?.isHourly) {
    const code = input.packageCode || null;
    if (code) {
      const p = await run('SELECT * FROM hire_packages WHERE code=$1 AND active', [code]);
      if (!p.rowCount) errors.packageCode = 'Choose a package';
      else {
        pkg = { code: p.rows[0].code, label: p.rows[0].label, hours: p.rows[0].hours, price: Number(p.rows[0].price) };
        hours = pkg.hours;
      }
    } else if (input.hours !== undefined && input.hours !== null && input.hours !== '') {
      hours = Number(input.hours); // amendments of older bookings
      if (!Number.isInteger(hours) || hours < service.minHours || hours > service.maxHours) {
        errors.hours = `Choose between ${service.minHours} and ${service.maxHours} hours`;
      }
    } else errors.packageCode = 'Choose a package';
  }

  const locations = (await run('SELECT name, kind, lat, lng FROM locations')).rows.map((l) => ({
    ...l,
    lat: Number(l.lat),
    lng: Number(l.lng),
  }));
  const airports = new Set(locations.filter((l) => l.kind === 'airport').map((l) => l.name.toLowerCase()));
  if (service?.needsAirport && pickup && destination && !errors.destination) {
    if (!airports.has(pickup.toLowerCase()) && !airports.has(destination.toLowerCase())) {
      errors.destination = `${service.label} needs an airport as the pickup or the destination`;
    }
  }

  // N16: optional return journey on the same booking.
  let returnAt = null;
  if (input.returnAt) {
    returnAt = new Date(input.returnAt);
    if (service?.isHourly) errors.returnAt = 'Daily hire already returns you to the start';
    else if (Number.isNaN(returnAt.getTime())) errors.returnAt = 'Choose a return date and time';
  }

  if (Object.keys(errors).length) throw badRequest('Please check the highlighted fields', errors);

  const distance = service.isHourly
    ? { miles: 0, source: 'hourly' }
    : estimateDistance(pickup, destination, locations, { longDistance: service.code === 'long_distance' });
  const durationMinutes = estimateDuration({ miles: distance.miles, hours, isHourly: service.isHourly });
  const window = bookingWindow(pickupAt, durationMinutes);

  if (returnAt) {
    if (returnAt.getTime() < window.end.getTime()) {
      throw badRequest('Please check the highlighted fields', {
        returnAt: `The return must be after the outward journey ends (about ${new Date(window.end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })})`,
      });
    }
    if (returnAt.getTime() > now.getTime() + cfg.maxDaysAhead * 86_400_000) {
      throw badRequest('Please check the highlighted fields', { returnAt: `You can book up to ${cfg.maxDaysAhead} days ahead` });
    }
  }

  return {
    service, pickup, destination, pickupAt, asap, passengers, luggage, childSeatAges, pet, accessibility,
    passengerName, passengerPhone, flightNo, noteToDriver, hours, pkg, distance, durationMinutes, window, returnAt,
    night: isNight(pickupAt),
    inZone: !service.isHourly && (inCentralZone(pickup, locations) || inCentralZone(destination, locations)),
    locations,
  };
}

/** Price one size for a prepared journey (ID-51, ID-52, ID-31, ID-73). */
export function priceFor(settings, j, size, { channel, couponAmount = 0, couponLabel } = {}) {
  return computeQuote({
    service: j.service,
    size: { ...size, multiplier: Number(size.multiplier) },
    miles: j.distance.miles,
    hours: j.hours,
    pkg: j.pkg,
    channel,
    onlineDiscountPct: settings.onlineDiscountPct,
    couponAmount,
    couponLabel,
    minFare: settings.minFare,
    night: j.night,
    inZone: j.inZone,
    surcharges: settings.surcharges,
  });
}

/** ID-30: the size must seat everyone and carry the luggage. Returns a field-error object (empty = fits). */
export function sizeProblems(size, j) {
  const e = {};
  if (j.passengers > size.seats) {
    e.passengers = `${size.label} carries up to ${size.seats} passengers. Choose a bigger cab or fewer passengers.`;
    e.sizeCode = 'Choose a bigger cab';
  } else if (j.luggage > size.luggage) {
    e.luggage = `${size.label} takes up to ${size.luggage} bags. Choose a bigger cab.`;
    e.sizeCode = 'Choose a bigger cab';
  }
  return e;
}

/** ID-50: alternatives when nothing is free - other sizes at that time, or other start times for the same size. */
export async function findAlternatives(db, j, sizes, sizeCode, settings = null) {
  const cfg = settings || (await getSettings(db));
  const wheelchair = j.accessibility.includes('wheelchair');
  const sizeOptions = [];
  const free = await findAvailableCabs(db, { start: j.window.start, end: j.window.end, wheelchair });
  const counts = {};
  for (const c of free) counts[c.size_code] = (counts[c.size_code] || 0) + 1;
  for (const s of sizes) {
    if (s.code !== sizeCode && !Object.keys(sizeProblems(s, j)).length && counts[s.code]) {
      sizeOptions.push({ code: s.code, label: s.label, available: counts[s.code] });
    }
  }
  const times = [];
  for (const offset of [-60, -30, 30, 60, 90, 120, 180, 240]) {
    const start = new Date(j.pickupAt.getTime() + offset * 60_000);
    if (start.getTime() < Date.now() + cfg.minLeadMinutes * 60_000) continue;
    const w = bookingWindow(start, j.durationMinutes);
    const cabs = await findAvailableCabs(db, { start: w.start, end: w.end, sizeCode, wheelchair });
    if (cabs.length) times.push(start.toISOString());
    if (times.length >= 4) break;
  }
  return { sizes: sizeOptions, times };
}

export async function loadBookingRow(db, id) {
  const run = db ? db.query.bind(db) : query;
  const { rows } = await run(
    `SELECT b.*, s.label AS service_label, z.label AS size_label, z.seats AS size_seats, z.luggage AS size_luggage,
            c.reg AS cab_reg, c.make AS cab_make, c.model AS cab_model, c.colour AS cab_colour,
            c.wheelchair_accessible AS cab_wheelchair,
            d.full_name AS driver_name, d.phone AS driver_phone, d.licence_no AS driver_licence, d.photo_url AS driver_photo,
            u.full_name AS customer_name, u.email AS customer_email, u.phone AS customer_phone,
            p.label AS package_label
       FROM bookings b
       JOIN services s ON s.code = b.service_code
       JOIN cab_sizes z ON z.code = b.size_code
       JOIN cabs c ON c.id = b.cab_id
       LEFT JOIN drivers d ON d.id = b.driver_id
       JOIN users u ON u.id = b.customer_id
       LEFT JOIN hire_packages p ON p.code = b.package_code
      WHERE b.id = $1`,
    [id],
  );
  return rows[0] || null;
}

/** Customers may change or cancel until `cancelWindowHours` before the journey time in force (R10, ID-62). */
export function modifiable(row, cancelWindowHours, now = new Date()) {
  if (!['confirmed', 'assigned'].includes(row.status)) return false;
  return new Date(row.pickup_at).getTime() - now.getTime() >= cancelWindowHours * 3600_000;
}

const VEHICLE_STATES = ['assigned', 'on_route', 'arrived', 'in_progress', 'completed', 'interrupted'];

export function serializeBooking(row, { cancelWindowHours = 24, forStaff = false } = {}) {
  const showVehicle = forStaff || VEHICLE_STATES.includes(row.status);
  const firstName = row.driver_name ? row.driver_name.split(' ')[0] : null;
  return {
    id: row.id,
    ref: row.ref,
    status: row.status,
    service: { code: row.service_code, label: row.service_label },
    pickup: row.pickup,
    destination: row.destination,
    distanceMiles: row.distance_miles,
    hours: row.hours,
    package: row.package_code ? { code: row.package_code, label: row.package_label } : null,
    pickupAt: row.pickup_at,
    endAt: row.end_at,
    asap: row.asap,
    passengers: row.passengers,
    luggage: row.luggage,
    childSeatAges: row.child_seat_ages || [],
    pet: row.pet,
    accessibility: row.accessibility || [],
    passenger: row.passenger_name ? { name: row.passenger_name, phone: row.passenger_phone } : null,
    flightNo: row.flight_no,
    noteToDriver: row.note_to_driver,
    size: { code: row.size_code, label: row.size_label, seats: row.size_seats },
    channel: row.channel,
    priority: row.priority,
    notifyPref: row.notify_pref,
    notifyPhone: row.notify_phone,
    groupId: row.group_id,
    returnOf: row.return_of,
    holdExpiresAt: row.status === 'pending_payment' ? row.hold_expires_at : null,
    price: {
      full: row.price_full,
      surcharge: row.surcharge_total,
      discountOnline: row.discount_online,
      discountOffer: row.discount_offer,
      offerCode: row.offer_code,
      total: row.total,
      lines: row.price_lines || [],
    },
    // ID-45, ID-46: car registration, colour and make, driver first name, licence number and photo.
    vehicle: showVehicle
      ? { reg: row.cab_reg, make: row.cab_make, model: row.cab_model, colour: row.cab_colour, wheelchairAccessible: row.cab_wheelchair }
      : null,
    driver:
      showVehicle && row.driver_name
        ? {
            name: forStaff ? row.driver_name : firstName,
            licenceNo: row.driver_licence,
            photoUrl: row.driver_photo || null,
            ...(forStaff ? { phone: row.driver_phone } : {}),
          }
        : null,
    etaMinutes: row.eta_minutes,
    arrivalSmsSent: !!row.arrival_sms_sent_at,
    paymentStatus: row.payment_status ?? null,
    modifiable: modifiable(row, cancelWindowHours),
    cancelDeadline: new Date(new Date(row.pickup_at).getTime() - cancelWindowHours * 3600_000).toISOString(),
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
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
    row.return_of ? 'Your return journey is confirmed.' : 'Your Private Hire Cars booking is confirmed.',
    '',
    `Booking reference: ${row.ref}`,
    `Service: ${row.service_label}${row.package_label ? ` - ${row.package_label}` : ''}`,
    `Pickup: ${row.pickup}`,
    `Destination: ${row.destination}`,
    `When: ${fmt(row.pickup_at)}`,
    `Passengers: ${row.passengers}${row.luggage ? `, ${row.luggage} bag(s)` : ''}`,
    `Cab size: ${row.size_label}`,
  ];
  if (row.passenger_name) lines.push(`Passenger: ${row.passenger_name} (${row.passenger_phone})`);
  if (row.flight_no) lines.push(`Flight: ${row.flight_no} - we follow the landing time, with no waiting charge for a delay`);
  if (row.child_seat_ages?.length) lines.push(`Child seats: ${row.child_seat_ages.length} (ages ${row.child_seat_ages.join(', ')})`);
  if (row.pet) lines.push('Travelling with a pet');
  for (const a of row.accessibility || []) lines.push(`${ACCESSIBILITY_LABEL[a]} (no extra charge)`);
  lines.push('');
  for (const l of row.price_lines || []) lines.push(`${l.label}: ${gbp(l.amount)}`);
  if (Number(row.discount_online) > 0) lines.push(`Online discount: -${gbp(row.discount_online)}`);
  if (Number(row.discount_offer) > 0) lines.push(`Coupon ${row.offer_code}: -${gbp(row.discount_offer)}`);
  lines.push(`Total: ${gbp(row.total)}`);
  if (paidWith) lines.push(`Payment: ${paidWith}`);
  lines.push('');
  if (['text', 'both'].includes(row.notify_pref)) {
    lines.push(`About 10-15 minutes before arrival we will text ${row.notify_phone} with your car's registration, colour and make.`, '');
  }
  lines.push(
    'You can cancel or change this booking free of charge up to 24 hours before pickup from My trips.',
    '',
    'The Private Hire Cars team',
  );
  return { subject: `Booking confirmed - ${row.ref}`, body: lines.join('\n') };
}

export const lockCabSize = (db, sizeCode) =>
  db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['booking-size:' + sizeCode]);

/** Insert one booking on the first free cab (the exclusion constraint is the final guard against double booking). */
async function insertOnFreeCab(db, j, size, values) {
  const wheelchair = j.accessibility.includes('wheelchair');
  await lockCabSize(db, size.code);
  const candidates = await findAvailableCabs(db, { start: j.window.start, end: j.window.end, sizeCode: size.code, wheelchair });
  for (const cab of candidates) {
    await db.query('SAVEPOINT try_cab');
    try {
      const v = { ...values, cab_id: cab.id };
      const cols = Object.keys(v);
      const { rows } = await db.query(
        `INSERT INTO bookings (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
        cols.map((c) => v[c]),
      );
      await db.query('RELEASE SAVEPOINT try_cab');
      return rows[0].id;
    } catch (e) {
      await db.query('ROLLBACK TO SAVEPOINT try_cab');
      if (e.code !== '23P01') throw e;
    }
  }
  return null;
}

/**
 * Create a booking (and its return journey, N16) inside a transaction: validate, find a free cab of the right size,
 * price it on the server, insert.
 * Online bookings start as `pending_payment` and hold the cab for 15 minutes until payment succeeds (ID-53);
 * staff bookings are confirmed at once when payment is recorded (ID-35, ID-36).
 */
export async function createBooking(db, { customer, input, channel, createdBy = null, status = 'pending_payment' }) {
  const settings = await getSettings(db);
  await expireHolds(db);
  const j = await prepareJourney(db, input, { settings });

  const sizes = (await db.query('SELECT * FROM cab_sizes ORDER BY sort')).rows;
  const size = sizes.find((s) => s.code === input.sizeCode);
  if (!size) throw badRequest('Choose a cab size', { sizeCode: 'Choose a cab size' });
  const misfit = sizeProblems(size, j);
  if (Object.keys(misfit).length) throw badRequest('That cab is too small', misfit);

  // ID-73: one coupon from the wallet, one use per account, checked inside the transaction.
  const coupon = input.offerCode ? await resolveCoupon(db, input.offerCode, customer.id) : null;
  const groupId = crypto.randomUUID();
  const notifyPref = input.notifyPref || customer.notify_pref || 'email';
  const textTo = j.passengerPhone || customer.phone;

  const build = (leg, quote) => ({
    ref: newRef(),
    customer_id: customer.id,
    service_code: j.service.code,
    pickup: leg.pickup,
    destination: leg.destination,
    distance_miles: j.distance.miles,
    hours: j.hours,
    pickup_at: leg.window.start,
    end_at: leg.window.end,
    passengers: j.passengers,
    size_code: size.code,
    channel,
    priority: channel === 'online', // ID-34: online customers get priority
    notify_pref: notifyPref,
    notify_phone: ['text', 'both'].includes(notifyPref) ? textTo : null,
    price_full: quote.full,
    surcharge_total: quote.surcharge,
    discount_online: quote.discountOnline,
    discount_offer: quote.discountOffer,
    offer_code: quote.discountOffer > 0 ? coupon.code : null,
    coupon_amount: quote.discountOffer > 0 ? quote.discountOffer : 0,
    total: quote.total,
    price_lines: JSON.stringify(quote.lines),
    created_by: createdBy,
    notes: input.notes || null,
    status,
    hold_expires_at: status === 'pending_payment' ? new Date(Date.now() + settings.holdMinutes * 60_000) : null,
    payment_status: status === 'pending_payment' ? 'pending' : 'unpaid',
    group_id: groupId,
    return_of: leg.returnOf || null,
    luggage: j.luggage,
    child_seat_ages: j.childSeatAges,
    pet: j.pet,
    accessibility: j.accessibility,
    passenger_name: j.passengerName,
    passenger_phone: j.passengerPhone,
    flight_no: leg.returnOf ? null : j.flightNo,
    note_to_driver: j.noteToDriver,
    package_code: j.pkg?.code || null,
    terms_accepted_at: input.acceptTerms ? new Date() : null,
    asap: j.asap,
  });

  const outwardQuote = priceFor(settings, j, size, {
    channel,
    couponAmount: coupon ? Number(coupon.amount) : 0,
    couponLabel: coupon ? `Coupon ${coupon.code}` : undefined,
  });
  const outwardId = await insertOnFreeCab(db, j, size, build({ pickup: j.pickup, destination: j.destination, window: j.window }, outwardQuote));
  if (!outwardId) {
    const alternatives = await findAlternatives(db, j, sizes, size.code, settings);
    throw new HttpError(409, `No ${size.label} is free at that time. Pick another time or a different cab size.`, 'no_availability').withExtra({ alternatives });
  }
  await recordDiscounts(db, outwardId, outwardQuote);
  if (outwardQuote.discountOffer > 0) {
    await db.query('INSERT INTO coupon_redemptions (offer_id, user_id, booking_id) VALUES ($1,$2,$3)', [coupon.id, customer.id, outwardId]);
  }

  const ids = [outwardId];
  if (j.returnAt) {
    // The return leg reverses the addresses; the night/zone rules are worked out for its own time.
    const rj = await prepareJourney(
      db,
      { ...input, pickup: j.destination, destination: j.pickup, pickupAt: j.returnAt.toISOString(), returnAt: null, asap: false, flightNo: null },
      { settings },
    );
    const returnQuote = priceFor(settings, rj, size, { channel });
    const returnId = await insertOnFreeCab(db, rj, size, build({ pickup: rj.pickup, destination: rj.destination, window: rj.window, returnOf: outwardId }, returnQuote));
    if (!returnId) {
      const alternatives = await findAlternatives(db, rj, sizes, size.code, settings);
      throw new HttpError(409, `No ${size.label} is free for your return journey. Pick another return time or cab size.`, 'no_availability_return').withExtra({ alternatives });
    }
    await recordDiscounts(db, returnId, returnQuote);
    ids.push(returnId);
  }

  const rows = [];
  for (const id of ids) rows.push(await loadBookingRow(db, id));
  return { rows, row: rows[0], groupId, settings, coupon };
}

/** Figure F3: APPLIED_DISCOUNT rows, in the order they were applied. */
export async function recordDiscounts(db, bookingId, quote) {
  await db.query('DELETE FROM applied_discounts WHERE booking_id=$1', [bookingId]);
  for (const d of quote.discounts) {
    await db.query('INSERT INTO applied_discounts (booking_id, kind, label, amount, sequence) VALUES ($1,$2,$3,$4,$5)', [
      bookingId, d.kind, d.label, d.amount, d.sequence,
    ]);
  }
}

/** Bookings of a group (outward first), locked for update. */
export async function loadGroup(db, groupId) {
  const { rows } = await db.query('SELECT id FROM bookings WHERE group_id=$1 ORDER BY pickup_at FOR UPDATE', [groupId]);
  const out = [];
  for (const r of rows) out.push(await loadBookingRow(db, r.id));
  return out;
}
