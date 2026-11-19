// Pricing and journey estimation. Pure functions (no database) so every rule is unit-tested.
//
// Fare rules (report Table 17, decided 28 Oct and 19 Nov):
//   distance services : max(min_fare, base_fare + per_mile x miles x size_multiplier) + service fee
//   daily hire (ID-75): package price x size_multiplier
//   surcharges (ID-52): night (22:00-05:59 London time) and bad weather as % of the fare, plus a central-zone fee
//   programme discount: the 15% online discount (R3), ONLY for channel = 'online', applied first
//   coupon (ID-73)    : one fixed-amount coupon, applied to the reduced price
//   floor             : the fare never falls below GBP 5 after discounts
//   The price is always calculated on the server, and the quoted price stands even with traffic (ID-51).

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const money2 = round2;

const toRad = (d) => (d * Math.PI) / 180;

export function haversineMiles(a, b) {
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const ROAD_FACTOR = 1.15; // straight line -> typical road distance

/** Small deterministic hash so the same free-text addresses always give the same estimate. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Distance between two places. Known places (from the locations table) use road-adjusted great-circle distance;
 * free-text addresses get a stable estimate. A real build would call a routing API here.
 */
export function estimateDistance(pickup, destination, locations, { longDistance = false } = {}) {
  const byName = new Map(locations.map((l) => [norm(l.name), l]));
  const a = byName.get(norm(pickup));
  const b = byName.get(norm(destination));
  if (a && b) {
    const miles = Math.max(0.5, haversineMiles(a, b) * ROAD_FACTOR);
    return { miles: Math.round(miles * 10) / 10, source: 'places' };
  }
  const h = hash([norm(pickup), norm(destination)].sort().join('|'));
  const miles = longDistance ? 30 + (h % 500) / 10 : 2 + (h % 130) / 10;
  return { miles: Math.round(miles * 10) / 10, source: 'estimate' };
}

/** Minutes the cab is occupied (excluding the turnaround buffer). */
export function estimateDuration({ miles, hours, isHourly }) {
  if (isHourly) return hours * 60;
  const mph = miles > 40 ? 45 : 18;
  return Math.max(15, Math.round((miles / mph) * 60) + 10);
}

/** ID-52: pickups from 22:00 to 05:59 (UK time, BST or GMT) pay the night surcharge. */
export function isNight(pickupAt) {
  const h = Number(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/London' }).format(new Date(pickupAt)),
  );
  return h >= 22 || h < 6;
}

// Central London zone: within 1.6 miles of Charing Cross, or a central postcode district typed in an address.
const ZONE_CENTRE = { lat: 51.5074, lng: -0.1278 };
const ZONE_RADIUS_MILES = 1.6;
const ZONE_POSTCODE = /\b(WC[12][A-Z]?|EC[1-4][A-Z]?|W1[A-Z]?|SW1[A-Z]?)\s*\d[A-Z]{2}\b/i;

export function inCentralZone(place, locations) {
  const l = locations.find((x) => norm(x.name) === norm(place));
  if (l) return haversineMiles(l, ZONE_CENTRE) <= ZONE_RADIUS_MILES;
  return ZONE_POSTCODE.test(place);
}

/**
 * Compute the price breakdown for one service + cab size (ID-32: the breakdown is shown before payment).
 * @returns {{full:number, surcharge:number, discountOnline:number, discountOffer:number, total:number, lines:Array, discounts:Array}}
 */
export function computeQuote({
  service,
  size,
  miles = 0,
  hours = null,
  pkg = null,
  channel,
  onlineDiscountPct,
  couponAmount = 0,
  couponLabel = 'Coupon',
  minFare = 5,
  night = false,
  inZone = false,
  surcharges = {},
}) {
  const lines = [];
  let fare;
  if (service.isHourly) {
    if (pkg) {
      fare = round2(pkg.price * size.multiplier);
      lines.push({ label: `${pkg.label} (${size.label})`, amount: fare });
    } else {
      fare = round2(service.hourlyRate * hours * size.multiplier);
      lines.push({ label: `${hours} hours at ${service.hourlyRate.toFixed(2)}/hour (${size.label})`, amount: fare });
    }
  } else {
    const distancePart = service.baseFare + service.perMile * miles * size.multiplier;
    fare = round2(Math.max(service.minFare, distancePart));
    lines.push({ label: `Journey of about ${miles} miles (${size.label})`, amount: fare });
    if (service.extraFee > 0) {
      lines.push({ label: `${service.label} fee`, amount: round2(service.extraFee) });
    }
  }
  const base = round2(lines.reduce((a, l) => a + l.amount, 0));

  // ID-52 surcharges
  let surcharge = 0;
  const nightPct = Number(surcharges.nightPct || 0);
  const weatherPct = Number(surcharges.weatherPct || 0);
  const zoneFee = Number(surcharges.zoneFee || 0);
  if (night && nightPct > 0) {
    const a = round2((fare * nightPct) / 100);
    lines.push({ label: `Night surcharge (${nightPct}%, 22:00 to 06:00)`, amount: a, kind: 'surcharge' });
    surcharge += a;
  }
  if (inZone && zoneFee > 0 && !service.isHourly) {
    lines.push({ label: 'Central London zone', amount: round2(zoneFee), kind: 'surcharge' });
    surcharge += zoneFee;
  }
  if (weatherPct > 0) {
    const a = round2((fare * weatherPct) / 100);
    lines.push({ label: `Bad weather surcharge (${weatherPct}%)`, amount: a, kind: 'surcharge' });
    surcharge += a;
  }
  surcharge = round2(surcharge);
  const full = round2(base + surcharge);

  // Programme discount first, then at most one coupon, with a floor (report Table 17 worked example).
  const discounts = [];
  const discountOnline = channel === 'online' ? round2((full * onlineDiscountPct) / 100) : 0;
  if (discountOnline > 0) discounts.push({ kind: 'programme', label: `Online booking discount (${onlineDiscountPct}%)`, amount: discountOnline, sequence: 1 });
  const afterProgramme = round2(full - discountOnline);
  const room = Math.max(0, round2(afterProgramme - minFare));
  const discountOffer = couponAmount > 0 ? round2(Math.min(couponAmount, room)) : 0;
  if (discountOffer > 0) discounts.push({ kind: 'coupon', label: couponLabel, amount: discountOffer, sequence: 2 });
  const total = round2(Math.max(afterProgramme - discountOffer, Math.min(afterProgramme, minFare)));
  return { full, surcharge, discountOnline, discountOffer, total, lines, discounts, floorApplied: couponAmount > 0 && discountOffer < couponAmount };
}
