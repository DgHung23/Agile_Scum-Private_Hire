import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from './db.js';
import { migrate } from './migrate.js';

/** Demo accounts - safe to run repeatedly (idempotent). Passwords are for local demo only. */
export const DEMO = {
  admin: { email: 'admin@privatehire.test', password: 'AdminPass123!', name: 'George Smith', role: 'admin', phone: '020 7000 0001' },
  manager: { email: 'manager@privatehire.test', password: 'ManagerPass123!', name: 'Jordan Blake', role: 'manager', phone: '020 7000 0003' },
  staff: { email: 'staff@privatehire.test', password: 'StaffPass123!', name: 'Sam Carter', role: 'staff', phone: '020 7000 0002', refundLimit: 50 },
  driver: { email: 'driver@privatehire.test', password: 'DriverPass123!', name: 'Mohammed Khan', role: 'driver', phone: '07700 910000' },
  customer: { email: 'customer@privatehire.test', password: 'Customer123!', name: 'Alex Morgan', role: 'customer', phone: '07700 900123', secretWord: 'bluebird', marketing: true },
};

async function upsertUser(u, extra = {}) {
  const hash = await bcrypt.hash(u.password, 10);
  const secret = u.secretWord ? await bcrypt.hash(u.secretWord, 10) : null;
  await query(
    `INSERT INTO users (role,email,password_hash,full_name,phone,address_line,city,postcode,notify_pref,
                        email_verified,marketing_consent,secret_word_hash,refund_limit)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12)
     ON CONFLICT (email) DO NOTHING`,
    [
      u.role,
      u.email,
      hash,
      u.name,
      u.phone,
      extra.address || '10 Downing Street',
      'London',
      extra.postcode || 'SW1A 2AA',
      extra.notify || 'both',
      !!u.marketing,
      secret,
      u.refundLimit ?? null,
    ],
  );
}

/* Known places: name, kind, lat, lng. Used for autocomplete and distance estimates. */
const LOCATIONS = [
  ['Heathrow Airport (Terminal 2)', 'airport', 51.47, -0.4543],
  ['Heathrow Airport (Terminal 5)', 'airport', 51.4723, -0.4875],
  ['Gatwick Airport (South Terminal)', 'airport', 51.156, -0.1611],
  ['London City Airport', 'airport', 51.5053, 0.0553],
  ['Stansted Airport', 'airport', 51.886, 0.2389],
  ['Luton Airport', 'airport', 51.8747, -0.3683],
  ["King's Cross St Pancras", 'station', 51.5308, -0.1238],
  ['Paddington Station', 'station', 51.5154, -0.1755],
  ['Waterloo Station', 'station', 51.5031, -0.1132],
  ['Victoria Station', 'station', 51.4952, -0.1441],
  ['Euston Station', 'station', 51.5282, -0.1337],
  ['Liverpool Street Station', 'station', 51.5178, -0.0823],
  ['London Bridge Station', 'station', 51.5052, -0.0864],
  ['Marylebone Station', 'station', 51.5225, -0.1631],
  ['The Ritz London', 'hotel', 51.5071, -0.1416],
  ['The Savoy', 'hotel', 51.5101, -0.1205],
  ['Hilton London Park Lane', 'hotel', 51.5048, -0.1511],
  ['The Dorchester', 'hotel', 51.5072, -0.1527],
  ["Claridge's", 'hotel', 51.5122, -0.1473],
  ['Premier Inn London County Hall', 'hotel', 51.5016, -0.1195],
  ['Park Plaza Westminster Bridge', 'hotel', 51.5013, -0.117],
  ['Shangri-La The Shard', 'hotel', 51.5045, -0.0865],
  ['Buckingham Palace', 'landmark', 51.5014, -0.1419],
  ['Tower of London', 'landmark', 51.5081, -0.0759],
  ['Wembley Stadium', 'landmark', 51.556, -0.2795],
  ['The O2 Arena', 'landmark', 51.503, 0.0032],
  ['Canary Wharf', 'area', 51.5054, -0.0235],
  ['Westminster', 'area', 51.4995, -0.1248],
  ['Piccadilly Circus', 'landmark', 51.51, -0.1347],
  ['Camden Town', 'area', 51.539, -0.1426],
  ['Covent Garden', 'area', 51.5129, -0.1243],
  ['Oxford Circus', 'landmark', 51.5152, -0.1415],
  ['Stratford (Westfield)', 'area', 51.5434, -0.0092],
  ['Greenwich', 'area', 51.4826, -0.0077],
  ['Richmond', 'area', 51.4613, -0.3037],
  ['Hampstead', 'area', 51.556, -0.178],
  ['Brixton', 'area', 51.4613, -0.1156],
  ['Shoreditch', 'area', 51.5265, -0.078],
  ['Oxford', 'area', 51.752, -1.2577],
  ['Cambridge', 'area', 52.2053, 0.1218],
  ['Brighton', 'area', 50.8225, -0.1372],
  ['Bristol', 'area', 51.4545, -2.5879],
  ['Birmingham', 'area', 52.4862, -1.8904],
  ['Cardiff', 'area', 51.4816, -3.1791],
  ['Manchester', 'area', 53.4808, -2.2426],
  ['Canterbury', 'area', 51.2802, 1.0789],
  ['Southampton', 'area', 50.9097, -1.4044],
  ['Reading', 'area', 51.4543, -0.9781],
];

const CAB_MODELS = {
  saloon: [['Toyota', 'Prius'], ['Skoda', 'Octavia'], ['Ford', 'Mondeo']],
  estate: [['Skoda', 'Octavia Estate'], ['Toyota', 'Corolla Touring'], ['Ford', 'Mondeo Estate']],
  mpv6: [['Ford', 'Galaxy'], ['VW', 'Touran']],
  mpv7: [['Toyota', 'Proace Verso'], ['Mercedes', 'V-Class'], ['VW', 'Sharan']],
  minibus: [['Ford', 'Transit Minibus'], ['Mercedes', 'Vito Tourer']],
};
const FLEET_PLAN = [['saloon', 12], ['estate', 6], ['mpv6', 4], ['mpv7', 5], ['minibus', 3]];
const COLOURS = ['Black', 'Silver', 'White', 'Grey', 'Blue', 'Black', 'Silver'];
const LETTERS = 'ABCDEFGHJKLMNOPRSTUVWXY';

const DRIVER_NAMES = [
  'Mohammed Khan', 'Olivia Brown', 'Kwame Mensah', 'Piotr Nowak', 'Aisha Rahman', 'Daniel Murphy', 'Sofia Rossi',
  'Tariq Hussain', 'Grace Okafor', 'Liam Walker', 'Anita Patel', 'Marek Kowalski', 'Hannah Clarke', 'Yusuf Ali',
  'Chloe Evans', 'Ivan Petrov', 'Fatima Begum', 'George Adams', 'Ruth Campbell', 'Samir Haddad',
];

export async function seedLocations() {
  for (const [name, kind, lat, lng] of LOCATIONS) {
    await query('INSERT INTO locations (name, kind, lat, lng) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING', [name, kind, lat, lng]);
  }
}

export async function seedFleet() {
  let n = 0;
  for (const [size, count] of FLEET_PLAN) {
    for (let i = 0; i < count; i++, n++) {
      const [make, model] = CAB_MODELS[size][i % CAB_MODELS[size].length];
      const reg = `${LETTERS[(n * 3) % 23]}${LETTERS[(n * 5 + 2) % 23]}${21 + (n % 4)} ${LETTERS[(n * 7) % 23]}${LETTERS[(n * 11 + 3) % 23]}${LETTERS[(n * 13 + 5) % 23]}`;
      await query(
        `INSERT INTO cabs (reg, make, model, colour, size_code, wheelchair_accessible) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING`,
        [reg, make, model, COLOURS[n % COLOURS.length], size, ['mpv7', 'minibus'].includes(size)], // ID-39: accessible vehicles
      );
    }
  }
  for (let i = 0; i < DRIVER_NAMES.length; i++) {
    await query(
      `INSERT INTO drivers (full_name, phone, licence_no) VALUES ($1,$2,$3) ON CONFLICT (licence_no) DO NOTHING`,
      [DRIVER_NAMES[i], `07700 9${String(10000 + i * 37).slice(-5)}`, `PHD-${10001 + i}`],
    );
  }
  // ID-65, ID-66: documents with expiry dates. One driver's licence is about to expire (shown as a warning).
  await query(
    `INSERT INTO documents (owner_type, owner_id, doc_type, reference, expires_on)
       SELECT 'cab', c.id, t.doc, upper(substr(md5(c.id::text || t.doc), 1, 8)), (now() + interval '9 months')::date
         FROM cabs c CROSS JOIN (VALUES ('phv_vehicle_licence'), ('insurance'), ('mot')) AS t(doc)
     ON CONFLICT DO NOTHING`,
  );
  await query(
    `INSERT INTO documents (owner_type, owner_id, doc_type, reference, expires_on)
       SELECT 'driver', d.id, t.doc, upper(substr(md5(d.id::text || t.doc), 1, 8)),
              CASE WHEN d.licence_no = 'PHD-10020' AND t.doc = 'phv_driver_licence' THEN (now() + interval '20 days')::date
                   ELSE (now() + interval '14 months')::date END
         FROM drivers d CROSS JOIN (VALUES ('phv_driver_licence'), ('driving_licence')) AS t(doc)
     ON CONFLICT DO NOTHING`,
  );
  // N34: the demo driver account signs in to the Driver view as the first driver.
  await query(
    `UPDATE drivers SET user_id = (SELECT id FROM users WHERE email = 'driver@privatehire.test')
      WHERE licence_no = 'PHD-10001' AND user_id IS NULL`,
  );
}

export async function seed() {
  for (const u of Object.values(DEMO)) await upsertUser(u);
  await seedLocations();
  await seedFleet();
  console.log('[seed] demo accounts, places, fleet and drivers ready');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate()
    .then(seed)
    .then(async () => {
      const { stopAutoDelivery } = await import('./services/notify.js');
      stopAutoDelivery();
      await pool.end();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
