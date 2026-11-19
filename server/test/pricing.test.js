import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNight, computeQuote, estimateDistance, estimateDuration, haversineMiles } from '../src/services/pricing.js';

const local = { code: 'local', label: 'Local journey', baseFare: 4, perMile: 2.2, minFare: 8, extraFee: 0, isHourly: false };
const airport = { code: 'airport', label: 'Airport transfer', baseFare: 8, perMile: 2, minFare: 25, extraFee: 5, isHourly: false };
const daily = { code: 'daily_hire', label: 'Driver & car by the day', hourlyRate: 28, isHourly: true, baseFare: 0, perMile: 0, minFare: 0, extraFee: 0 };
const saloon = { code: 'saloon', label: 'Saloon', multiplier: 1 };
const seven = { code: 'mpv7', label: 'Seven-seater', multiplier: 1.5 };

test('R3: online bookings get exactly 15% off', () => {
  const q = computeQuote({ service: local, size: saloon, miles: 5, channel: 'online', onlineDiscountPct: 15 });
  assert.equal(q.full, 15);
  assert.equal(q.discountOnline, 2.25);
  assert.equal(q.total, 12.75);
});

test('R3: phone and in-person bookings get no discount', () => {
  for (const channel of ['phone', 'in_person']) {
    const q = computeQuote({ service: local, size: saloon, miles: 5, channel, onlineDiscountPct: 15 });
    assert.equal(q.discountOnline, 0);
    assert.equal(q.total, q.full);
  }
});

test('US5.2: minimum fare applies to short journeys', () => {
  const q = computeQuote({ service: local, size: saloon, miles: 0.5, channel: 'phone', onlineDiscountPct: 15 });
  assert.equal(q.full, 8);
});

test('US5.2: bigger cabs cost more per mile', () => {
  const a = computeQuote({ service: local, size: saloon, miles: 10, channel: 'phone', onlineDiscountPct: 15 });
  const b = computeQuote({ service: local, size: seven, miles: 10, channel: 'phone', onlineDiscountPct: 15 });
  assert.equal(a.full, 26);
  assert.equal(b.full, 37);
});

test('airport transfers add the airport fee on top of the fare', () => {
  const q = computeQuote({ service: airport, size: saloon, miles: 10, channel: 'phone', onlineDiscountPct: 15 });
  assert.equal(q.full, 33);
  assert.equal(q.lines.length, 2);
});

test('daily hire is charged by the hour', () => {
  const q = computeQuote({ service: daily, size: saloon, hours: 6, channel: 'phone', onlineDiscountPct: 15 });
  assert.equal(q.full, 168);
});

test('ID-31, ID-73 report worked example: GBP 40 less 15% is 34.00, less a GBP 5 coupon is 29.00', () => {
  const flat = { isHourly: false, baseFare: 0, perMile: 1, minFare: 0, extraFee: 0, label: 'Local' };
  const q = computeQuote({ service: flat, size: saloon, miles: 40, channel: 'online', onlineDiscountPct: 15, couponAmount: 5 });
  assert.equal(q.full, 40);
  assert.equal(q.discountOnline, 6);
  assert.equal(q.discountOffer, 5);
  assert.equal(q.total, 29);
  assert.deepEqual(q.discounts.map((d) => [d.kind, d.sequence]), [['programme', 1], ['coupon', 2]], 'programme first, then the coupon');
});

test('ID-31 the fare never falls below GBP 5 after discounts', () => {
  const flat = { isHourly: false, baseFare: 0, perMile: 1, minFare: 0, extraFee: 0, label: 'Local' };
  const q = computeQuote({ service: flat, size: saloon, miles: 8, channel: 'online', onlineDiscountPct: 15, couponAmount: 10, minFare: 5 });
  assert.equal(q.total, 5);
  assert.equal(q.discountOffer, 1.8, 'only part of the coupon is used');
  assert.equal(q.floorApplied, true);
});

test('ID-52 surcharges: night %, central zone fee and bad weather %, shown as lines', () => {
  const flat = { isHourly: false, baseFare: 0, perMile: 1, minFare: 0, extraFee: 0, label: 'Local' };
  const q = computeQuote({
    service: flat, size: saloon, miles: 20, channel: 'phone', onlineDiscountPct: 15,
    night: true, inZone: true, surcharges: { nightPct: 20, zoneFee: 2.5, weatherPct: 10 },
  });
  assert.equal(q.surcharge, 4 + 2.5 + 2);
  assert.equal(q.full, 28.5);
  assert.equal(q.lines.filter((l) => l.kind === 'surcharge').length, 3);
  assert.ok(isNight('2026-07-20T21:30:00Z'), '22:30 British Summer Time is night');
  assert.ok(!isNight('2026-07-20T12:00:00Z'));
  assert.ok(isNight('2026-12-20T23:30:00Z'), '23:30 GMT is night');
});

test('ID-75 a daily hire package is priced per package and cab size', () => {
  const q = computeQuote({ service: daily, size: { ...saloon, multiplier: 1.5, label: 'Seven-seater' }, pkg: { code: 'half_day', label: 'Half day (4 hours)', hours: 4, price: 105 }, channel: 'online', onlineDiscountPct: 15 });
  assert.equal(q.full, 157.5);
  assert.match(q.lines[0].label, /Half day/);
});

test('distance: known places use road-adjusted great-circle distance; free text is a stable estimate', () => {
  const places = [
    { name: 'Heathrow Airport (Terminal 2)', lat: 51.47, lng: -0.4543 },
    { name: "King's Cross St Pancras", lat: 51.5308, lng: -0.1238 },
  ];
  const d = estimateDistance('heathrow airport (terminal 2)', "King's Cross St Pancras", places);
  assert.equal(d.source, 'places');
  assert.ok(d.miles > 14 && d.miles < 22, `distance ${d.miles}`);
  const e1 = estimateDistance('1 Some Road', '2 Other Street', places);
  const e2 = estimateDistance('2 Other Street', '1 Some Road', places);
  assert.equal(e1.source, 'estimate');
  assert.equal(e1.miles, e2.miles);
  const long = estimateDistance('1 Some Road', 'Leeds', places, { longDistance: true });
  assert.ok(long.miles >= 30);
  assert.ok(haversineMiles({ lat: 0, lng: 0 }, { lat: 0, lng: 0 }) === 0);
});

test('duration: urban speed for short trips, faster for long, hours for daily hire', () => {
  assert.equal(estimateDuration({ miles: 9, isHourly: false }), 40);
  assert.ok(estimateDuration({ miles: 90, isHourly: false }) < 150);
  assert.equal(estimateDuration({ hours: 5, isHourly: true }), 300);
});
