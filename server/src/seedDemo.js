import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, tx } from './db.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';
import { newRef } from './services/booking.js';
import { bookingWindow } from './services/availability.js';
import { computeQuote, estimateDistance, estimateDuration } from './services/pricing.js';

/**
 * Demo data for presentations: a believable history so reports, reviews, loyalty tiers and dispatch all have
 * something to show. Run with `npm run seed:demo`. Safe to run twice (it does nothing if bookings already exist).
 * NOT used by the automated tests.
 */
const CUSTOMERS = [
  ['Priya Shah', 'priya.shah@example.com', '07700 900201', '14 Fulham Road', 'SW3 6HH'],
  ['Tom Becker', 'tom.becker@example.com', '07700 900202', '3 Camden Lock', 'NW1 8AF'],
  ['Grace Liu', 'grace.liu@example.com', '07700 900203', '22 Brick Lane', 'E1 6QL'],
  ['Omar Haddad', 'omar.haddad@example.com', '07700 900204', '8 Station Road', 'SE1 7PB'],
  ['Hannah Moore', 'hannah.moore@example.com', '07700 900205', '41 Park Avenue', 'W2 2QD'],
  ['Luca Romano', 'luca.romano@example.com', '07700 900206', '5 Greenwich Walk', 'SE10 8JT'],
];
const ROUTES = [
  ['local', 'Camden Town', 'Covent Garden'], ['local', 'Brixton', 'Shoreditch'], ['local', 'Hampstead', 'Westminster'],
  ['airport', 'Paddington Station', 'Heathrow Airport (Terminal 5)'], ['airport', 'Canary Wharf', 'London City Airport'],
  ['airport', 'Gatwick Airport (South Terminal)', 'Victoria Station'], ['hotel', 'The Ritz London', 'Waterloo Station'],
  ['long_distance', 'Oxford Circus', 'Brighton'], ['meet_greet', 'Heathrow Airport (Terminal 2)', 'The Savoy'],
  ['daily_hire', 'Richmond', ''],
];
const COMMENTS = ['Clean car and very polite driver.', 'Arrived a little late but friendly.', 'Smooth ride, would book again.', 'Driver knew a great shortcut.', 'Car was a bit warm.', 'Excellent service from start to finish.'];

export async function seedDemo() {
  await seed();
  const have = (await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n;
  if (have > 0) return console.log('[seed:demo] bookings already exist - skipping');

  await tx(async (db) => {
    const hash = await bcrypt.hash('Customer123!', 10);
    const ids = [(await db.query("SELECT id FROM users WHERE email='customer@privatehire.test'")).rows[0].id];
    for (const [name, email, phone, addr, pc] of CUSTOMERS) {
      const r = await db.query(
        `INSERT INTO users (role,email,password_hash,full_name,phone,address_line,city,postcode,notify_pref,email_verified,marketing_consent)
         VALUES ('customer',$1,$2,$3,$4,$5,'London',$6,'both',true,true) ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id`,
        [email, hash, name, phone, addr, pc],
      );
      ids.push(r.rows[0].id);
    }
    const staffId = (await db.query("SELECT id FROM users WHERE email='staff@privatehire.test'")).rows[0].id;
    const locations = (await db.query('SELECT name, kind, lat, lng FROM locations')).rows.map((l) => ({ ...l, lat: Number(l.lat), lng: Number(l.lng) }));
    const sizes = (await db.query('SELECT * FROM cab_sizes ORDER BY sort')).rows;
    const services = Object.fromEntries((await db.query('SELECT * FROM services')).rows.map((s) => [s.code, {
      code: s.code, label: s.label, baseFare: s.base_fare, perMile: s.per_mile, hourlyRate: s.hourly_rate, extraFee: s.extra_fee,
      minFare: s.min_fare, isHourly: s.is_hourly,
    }]));
    const cabs = (await db.query('SELECT * FROM cabs WHERE active ORDER BY reg')).rows;
    const drivers = (await db.query('SELECT * FROM drivers WHERE active ORDER BY full_name')).rows;

    let n = 0;
    // weights: first customers travel more, to create loyalty tiers
    const weights = [14, 9, 7, 5, 3, 2, 1];
    const plan = weights.flatMap((w, ci) => Array.from({ length: w }, () => ci));
    for (const ci of plan) {
      n++;
      const [svc, from, to] = ROUTES[(n * 7 + ci) % ROUTES.length];
      const service = services[svc];
      const size = sizes[(n + ci) % 3 === 0 ? 3 : (n % 5 === 0 ? 4 : (n % 2 === 0 ? 1 : 0))];
      const daysAgo = 2 + ((n * 5) % 75);
      const when = new Date(Date.now() - daysAgo * 86400_000);
      when.setUTCHours(7 + ((n * 3) % 13), (n % 4) * 15, 0, 0);
      const hours = service.isHourly ? 4 + (n % 4) : null;
      const dist = service.isHourly ? { miles: 0 } : estimateDistance(from, to, locations, { longDistance: svc === 'long_distance' });
      const dur = estimateDuration({ miles: dist.miles, hours, isHourly: service.isHourly });
      const { start, end } = bookingWindow(when, dur);
      const channel = n % 5 === 0 ? 'phone' : n % 11 === 0 ? 'in_person' : 'online';
      const q = computeQuote({ service, size: { ...size, multiplier: Number(size.multiplier) }, miles: dist.miles, hours, channel, onlineDiscountPct: 15 });
      const cab = cabs.filter((c) => c.size_code === size.code)[n % cabs.filter((c) => c.size_code === size.code).length];
      const driver = drivers[n % drivers.length];
      const cust = ids[ci];
      const pax = Math.min(size.seats, 1 + (n % size.seats));
      let ins = null;
      await db.query('SAVEPOINT demo_row');
      try {
        ins = await db.query(
          `INSERT INTO bookings (ref, customer_id, service_code, pickup, destination, distance_miles, hours, pickup_at, end_at, passengers, size_code,
                                 cab_id, driver_id, channel, priority, notify_pref, status, price_full, discount_online, total, payment_status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'email','completed',$16,$17,$18,'paid',$19) RETURNING id`,
          [newRef(), cust, svc, from, to || 'Return to pickup location', dist.miles, hours, start, end, pax, size.code, cab.id, driver.id, channel,
            channel === 'online', q.full, q.discountOnline, q.total, channel === 'online' ? cust : staffId],
        );
        await db.query('RELEASE SAVEPOINT demo_row');
      } catch {
        await db.query('ROLLBACK TO SAVEPOINT demo_row'); // an overlapping demo slot is simply skipped
      }
      if (!ins) continue;
      const bid = ins.rows[0].id;
      await db.query(
        `INSERT INTO payments (booking_id, user_id, kind, method, amount, status, card_brand, card_last4, gateway_ref)
         VALUES ($1,$2,'charge','card',$3,'approved','visa','4242',$4)`,
        [bid, cust, q.total, 'VC-DEMO' + n],
      );
      if (n % 3 !== 0) {
        const rate = (base) => Math.max(1, Math.min(5, base + ((n + ci) % 3) - 1));
        await db.query(
          `INSERT INTO reviews (booking_id, customer_id, cab_id, driver_id, journey_rating, cab_rating, driver_rating, comment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [bid, cust, cab.id, driver.id, rate(4), rate(4), rate(drivers.indexOf(driver) % 6 === 0 ? 2 : 4), COMMENTS[n % COMMENTS.length]],
        );
      }
    }

    // a few upcoming bookings so dispatch and the dashboard are not empty
    const upcoming = [
      [0, 'airport', 'Paddington Station', 'Heathrow Airport (Terminal 5)', 3, 'confirmed', 'online'],
      [1, 'local', 'Camden Town', 'Covent Garden', 5, 'confirmed', 'online'],
      [2, 'hotel', 'The Dorchester', 'Waterloo Station', 8, 'assigned', 'phone'],
      [3, 'airport', 'Heathrow Airport (Terminal 2)', 'Westminster', 26, 'confirmed', 'online'],
      [0, 'local', 'Brixton', 'Shoreditch', 52, 'confirmed', 'online'],
    ];
    let u = 0;
    for (const [ci, svc, from, to, hrs, status, channel] of upcoming) {
      const size = sizes[u % 2];
      const service = services[svc];
      const dist = estimateDistance(from, to, locations);
      const dur = estimateDuration({ miles: dist.miles, isHourly: false });
      const { start, end } = bookingWindow(new Date(Date.now() + hrs * 3600_000), dur);
      const q = computeQuote({ service, size: { ...size, multiplier: Number(size.multiplier) }, miles: dist.miles, channel, onlineDiscountPct: 15 });
      const cab = cabs.filter((c) => c.size_code === size.code)[u];
      await db.query(
        `INSERT INTO bookings (ref, customer_id, service_code, pickup, destination, distance_miles, pickup_at, end_at, passengers, size_code, cab_id, driver_id,
                               channel, priority, notify_pref, notify_phone, status, price_full, discount_online, total, payment_status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,2,$9,$10,$11,$12,$13,'both','07700 900123',$14,$15,$16,$17,$18,$19)`,
        [newRef(), ids[ci], svc, from, to, dist.miles, start, end, size.code, cab.id, status === 'assigned' ? drivers[u].id : null, channel, channel === 'online',
          status, q.full, q.discountOnline, q.total, channel === 'online' ? 'paid' : 'unpaid', ids[ci]],
      );
      u++;
    }

    await db.query(
      `INSERT INTO enquiries (user_id, name, email, subject, message) VALUES
        (NULL, 'Visitor Vic', 'vic@example.com', 'Do you cover Kent?', 'We would like a weekly run to Canterbury. Do you cover that area and what would it cost?'),
        ($1, 'Priya Shah', 'priya.shah@example.com', 'Child seats', 'Can you provide two child seats for an airport transfer next month?')`,
      [ids[1]],
    );
  });
  console.log('[seed:demo] demo customers, 40+ historical bookings, reviews, upcoming jobs and enquiries added');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate()
    .then(seedDemo)
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
