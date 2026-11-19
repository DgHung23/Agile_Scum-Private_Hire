import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeQuote, estimateDistance, estimateDuration, haversineMiles } from '../src/services/pricing.js';

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

test('US10.4: an offer code stacks on top of the online discount', () => {
  const q = computeQuote({ service: daily, size: saloon, hours: 4, channel: 'online', onlineDiscountPct: 15, offerPct: 10 });
  assert.equal(q.full, 112);
  assert.equal(q.discountOnline, 16.8);
  assert.equal(q.discountOffer, 9.52);
  assert.equal(q.total, 85.68);
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
