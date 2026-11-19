import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { detectBrand, luhnValid, validateCard } from '../src/services/payments.js';

let t;
let cust;
before(async () => {
  t = await startServer();
  cust = await t.login('customer@privatehire.test', 'Customer123!');
});
after(() => t.close());

const card = (over = {}) => ({ number: '4242 4242 4242 4242', expMonth: 12, expYear: 2031, cvv: '123', holder: 'Alex Morgan', ...over });
const day = (n, h = 11) => {
  const d = new Date(Date.now() + n * 24 * 3600_000);
  d.setUTCHours(h, 0, 0, 0);
  return d.toISOString();
};
const book = (payment, over = {}) => ({
  serviceCode: 'local', pickup: 'Camden Town', destination: 'Covent Garden', pickupAt: day(4), passengers: 2,
  sizeCode: 'saloon', notifyPref: 'email', payment, ...over,
});

test('US5.3 card checks: brand detection and Luhn', () => {
  assert.equal(detectBrand('4242424242424242'), 'visa');
  assert.equal(detectBrand('5555555555554444'), 'mastercard');
  assert.equal(detectBrand('2221000000000009'), 'mastercard');
  assert.equal(detectBrand('378282246310005'), 'amex');
  assert.equal(detectBrand('6011111111111117'), null);
  assert.ok(luhnValid('4242 4242 4242 4242'));
  assert.ok(!luhnValid('4242 4242 4242 4241'));
});

test('US5.3 criterion 1: format, expiry in the future, Amex has 15 digits and a 4-digit code', () => {
  const now = new Date('2026-11-19T10:00:00Z');
  assert.deepEqual(validateCard(card(), now), {});
  assert.ok(validateCard(card({ number: '4242 4242 4242 4241' }), now).number);
  assert.ok(validateCard(card({ expMonth: 10, expYear: 2026 }), now).expYear, 'expired last month');
  assert.deepEqual(validateCard(card({ expMonth: 11, expYear: 2026 }), now), {}, 'valid through the end of the expiry month');
  assert.ok(validateCard(card({ expMonth: 13 }), now).expMonth);
  assert.ok(validateCard(card({ cvv: '12' }), now).cvv);
  const amex = card({ number: '3782 822463 10005', cvv: '1234' });
  assert.deepEqual(validateCard(amex, now), {});
  assert.ok(validateCard({ ...amex, cvv: '123' }, now).cvv, 'Amex needs 4 digits');
  assert.ok(validateCard({ ...amex, number: '3782 822463 1000' }, now).number, 'Amex must be 15 digits');
  assert.match(validateCard(card({ number: '6011111111111117' }), now).number, /Visa, Mastercard and American Express/);
});

test('US5.3 API returns card field errors under payment.card.*', async () => {
  const r = await t.call('POST', '/bookings', { token: cust, body: book({ method: 'card', card: card({ number: '4242424242424241', cvv: '1' }) }) });
  assert.equal(r.status, 400);
  assert.ok(r.body.error.fields['payment.card.number']);
  assert.ok(r.body.error.fields['payment.card.cvv']);
  const none = await t.call('POST', '/bookings', { token: cust, body: { ...book(undefined) } });
  assert.equal(none.status, 400, 'payment is required for online bookings');
});

test('US5.3 pay by card: booking confirmed and paid, receipt data complete, card number never stored', async () => {
  const r = await t.call('POST', '/bookings', { token: cust, body: book({ method: 'card', card: card() }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.booking.paymentStatus, 'paid');
  assert.equal(r.body.payment.cardLast4, '4242');
  assert.equal(r.body.payment.cardBrandLabel, 'Visa');
  assert.equal(r.body.payment.amount, r.body.booking.price.total);
  assert.match(r.body.payment.reference, /^VC-/);

  const dump = JSON.stringify((await t.pool.query('SELECT * FROM payments')).rows) + JSON.stringify((await t.pool.query('SELECT * FROM saved_cards')).rows);
  assert.ok(!dump.includes('4242424242424242') && !dump.includes('4242 4242'), 'full card number must not be stored');

  const mail = await t.pool.query("SELECT body FROM notifications WHERE kind='booking_confirmed' AND booking_id=$1", [r.body.booking.id]);
  assert.match(mail.rows[0].body, /Paid with: Visa ending 4242/);

  const rc = await t.call('GET', `/bookings/${r.body.booking.id}/receipt`, { token: cust });
  assert.equal(rc.status, 200);
  const x = rc.body.receipt;
  assert.match(x.receiptNo, /^RC-/);
  assert.equal(x.booking.pickup, 'Camden Town');
  assert.equal(x.price.discountOnline > 0, true);
  assert.equal(x.totalPaid, r.body.booking.price.total);
  assert.equal(x.netPaid, x.totalPaid);
  assert.equal(x.payments[0].description, 'Visa ending 4242');
});

test('US5.3 criterion 3: a declined card shows a clear error and the booking is NOT confirmed', async () => {
  const before = (await t.pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n;
  for (const [number, text] of [['4000 0000 0000 0002', /declined/], ['4000 0000 0000 9995', /insufficient funds/]]) {
    const r = await t.call('POST', '/bookings', { token: cust, body: book({ method: 'card', card: card({ number }) }, { pickupAt: day(5) }) });
    assert.equal(r.status, 402);
    assert.equal(r.body.error.code, 'payment_declined');
    assert.match(r.body.error.message, text);
  }
  const after = (await t.pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n;
  assert.equal(after, before, 'no booking row left behind (rolled back)');
  const log = await t.pool.query("SELECT * FROM payments WHERE status='declined'");
  assert.equal(log.rowCount, 2, 'declined attempts are kept for audit');
  assert.equal(log.rows[0].booking_id, null);
  // the cab that was tentatively reserved is free again
  const ok = await t.call('POST', '/bookings', { token: cust, body: book({ method: 'card', card: card() }, { pickupAt: day(5) }) });
  assert.equal(ok.status, 201);
});

test('US1.4 saved cards: save, list masked, pay with saved card, delete', async () => {
  const empty = await t.call('POST', '/payments/cards', { token: cust, body: card({ number: '1111' }) });
  assert.equal(empty.status, 400);
  const saved = await t.call('POST', '/payments/cards', { token: cust, body: card({ number: '5555 5555 5555 4444', cvv: '999', holder: 'Alex M' }) });
  assert.equal(saved.status, 201);
  assert.deepEqual(Object.keys(saved.body.card).sort(), ['brand', 'brandLabel', 'expMonth', 'expYear', 'expired', 'holder', 'id', 'last4']);
  assert.equal(saved.body.card.last4, '4444');
  const list = await t.call('GET', '/payments/cards', { token: cust });
  assert.equal(list.body.cards.length, 1);

  const noCvv = await t.call('POST', '/bookings', { token: cust, body: book({ method: 'card', savedCardId: saved.body.card.id }, { pickupAt: day(6) }) });
  assert.equal(noCvv.status, 400);
  const paid = await t.call('POST', '/bookings', { token: cust, body: book({ method: 'card', savedCardId: saved.body.card.id, cvv: '123' }, { pickupAt: day(6) }) });
  assert.equal(paid.status, 201);
  assert.equal(paid.body.payment.cardBrandLabel, 'Mastercard');

  const other = await t.call('POST', '/auth/register', { body: { fullName: 'Pat Other', email: 'pat@example.com', phone: '07700 900321', addressLine: '2 Road', city: 'London', postcode: 'N1 9GU', password: 'Passw0rd1' } });
  assert.equal(other.status, 201);
  const otherTok = await t.login('pat@example.com', 'Passw0rd1');
  assert.equal((await t.call('DELETE', `/payments/cards/${saved.body.card.id}`, { token: otherTok })).status, 404, "cannot delete someone else's card");
  assert.equal((await t.call('DELETE', `/payments/cards/${saved.body.card.id}`, { token: cust })).status, 200);
  assert.equal((await t.call('GET', '/payments/cards', { token: cust })).body.cards.length, 0);
});

test('US1.4 "save this card" while paying stores only the masked card', async () => {
  const r = await t.call('POST', '/bookings', { token: cust, body: book({ method: 'card', card: card({ number: '3782 822463 10005', cvv: '1234' }), saveCard: true }, { pickupAt: day(7) }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const cards = (await t.call('GET', '/payments/cards', { token: cust })).body.cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].brand, 'amex');
  assert.equal(cards[0].last4, '0005');
});

test('US5.4 PayPal: approve then pay; cancelled, unapproved and changed-price sessions fail', async () => {
  const q = book(undefined, { pickupAt: day(8) });
  const quote = await t.call('POST', '/bookings/quote', { body: { ...q, sizeCode: undefined } });
  const total = quote.body.sizes.find((s) => s.code === 'saloon').price.total;

  const s1 = (await t.call('POST', '/payments/paypal/start', { token: cust, body: { amount: total } })).body;
  const notApproved = await t.call('POST', '/bookings', { token: cust, body: { ...q, payment: { method: 'paypal', token: s1.token } } });
  assert.equal(notApproved.status, 402);

  assert.equal((await t.call('POST', `/payments/paypal/${s1.token}/approve`, { token: cust, body: { email: 'bad' } })).status, 400);
  await t.call('POST', `/payments/paypal/${s1.token}/approve`, { token: cust, body: { email: 'alex@paypal.example' } });
  const wrongAmount = (await t.call('POST', '/payments/paypal/start', { token: cust, body: { amount: total + 5 } })).body;
  await t.call('POST', `/payments/paypal/${wrongAmount.token}/approve`, { token: cust, body: { email: 'alex@paypal.example' } });
  const mismatch = await t.call('POST', '/bookings', { token: cust, body: { ...q, payment: { method: 'paypal', token: wrongAmount.token } } });
  assert.equal(mismatch.status, 402);
  assert.match(mismatch.body.error.message, /price changed/);

  const ok = await t.call('POST', '/bookings', { token: cust, body: { ...q, payment: { method: 'paypal', token: s1.token } } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.payment.method, 'paypal');
  assert.equal(ok.body.payment.paypalPayer, 'alex@paypal.example');
  const reuse = await t.call('POST', '/bookings', { token: cust, body: { ...q, pickupAt: day(9), payment: { method: 'paypal', token: s1.token } } });
  assert.equal(reuse.status, 402, 'a PayPal approval can only be used once');

  const s2 = (await t.call('POST', '/payments/paypal/start', { token: cust, body: { amount: total } })).body;
  await t.call('POST', `/payments/paypal/${s2.token}/cancel`, { token: cust });
  const cancelled = await t.call('POST', '/bookings', { token: cust, body: { ...q, pickupAt: day(9), payment: { method: 'paypal', token: s2.token } } });
  assert.equal(cancelled.status, 402);
  assert.match(cancelled.body.error.message, /cancelled/);
});

test('US6.1 a customer cannot open someone else\'s receipt', async () => {
  const mine = (await t.call('GET', '/bookings?when=all', { token: cust })).body.bookings[0];
  const otherTok = await t.login('pat@example.com', 'Passw0rd1');
  assert.equal((await t.call('GET', `/bookings/${mine.id}/receipt`, { token: otherTok })).status, 404);
});
