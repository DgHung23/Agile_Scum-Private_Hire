// Pricing and journey estimation. Pure functions (no database) so every rule is unit-tested.
//
// Fare rules (documented assumptions - see docs/SPRINTS.md):
//   distance services : max(min_fare, base_fare + per_mile x miles x size_multiplier) + extra_fee
//   hourly (daily hire): hourly_rate x hours x size_multiplier
//   R3 online discount: % off the full price, ONLY for channel = 'online'
//   offer code        : % off the price after the online discount (stacks)

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

/**
 * Compute the price breakdown for one service + cab size.
 * @returns {{full:number, discountOnline:number, discountOffer:number, total:number, lines:Array}}
 */
export function computeQuote({ service, size, miles = 0, hours = null, channel, onlineDiscountPct, offerPct = 0 }) {
  let fare;
  const lines = [];
  if (service.isHourly) {
    fare = round2(service.hourlyRate * hours * size.multiplier);
    lines.push({ label: `${hours} hours at ${service.hourlyRate.toFixed(2)}/hour (${size.label})`, amount: fare });
  } else {
    const distancePart = service.baseFare + service.perMile * miles * size.multiplier;
    fare = round2(Math.max(service.minFare, distancePart));
    lines.push({ label: `Journey of about ${miles} miles (${size.label})`, amount: fare });
    if (service.extraFee > 0) {
      lines.push({ label: `${service.label} fee`, amount: round2(service.extraFee) });
      fare = round2(fare + service.extraFee);
    }
  }
  const full = fare;
  const discountOnline = channel === 'online' ? round2((full * onlineDiscountPct) / 100) : 0;
  const afterOnline = round2(full - discountOnline);
  const discountOffer = offerPct > 0 ? round2((afterOnline * offerPct) / 100) : 0;
  const total = round2(afterOnline - discountOffer);
  return { full, discountOnline, discountOffer, total, lines };
}
