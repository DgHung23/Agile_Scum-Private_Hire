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
  const r = await t.book(cust, book({ method: 'card', card: card({ number: '4242424242424241', cvv: '1' }) }));
  assert.equal(r.status, 400);
  assert.ok(r.body.error.fields['payment.card.number']);
  assert.ok(r.body.error.fields['payment.card.cvv']);
  const none = await t.book(cust, { ...book(undefined) });
  assert.equal(none.status, 400, 'payment is required for online bookings');
});

test('US5.3 pay by card: booking confirmed and paid, receipt data complete, card number never stored', async () => {
  const r = await t.book(cust, book({ method: 'card', card: card() }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.booking.paymentStatus, 'paid');
  assert.equal(r.body.payment.cardLast4, '4242');
  assert.equal(r.body.payment.cardBrandLabel, 'Visa');
  assert.equal(r.body.payment.amount, r.body.booking.price.total);
  assert.match(r.body.payment.reference, /^VC-/);

  const dump = JSON.stringify((await t.pool.query('SELECT * FROM payments')).rows) + JSON.stringify((await t.pool.query('SELECT * FROM saved_cards')).rows);
  assert.ok(!dump.includes('4242424242424242') && !dump.includes('4242 4242'), 'full card number must not be stored');

  const mail = await t.pool.query("SELECT body FROM notifications WHERE kind='booking_confirmed' AND booking_id=$1", [r.body.booking.id]);
  assert.match(mail.rows[0].body, /Payment: Visa ending 4242/);

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
    const r = await t.book(cust, book({ method: 'card', card: card({ number }) }, { pickupAt: day(5) }));
    assert.equal(r.status, 402);
    assert.equal(r.body.error.code, 'payment_declined');
    assert.match(r.body.error.message, text);
  }
  const after = await t.pool.query("SELECT status, payment_status FROM bookings ORDER BY created_at DESC LIMIT 2");
  assert.equal((await t.pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, before + 2);
  assert.ok(after.rows.every((b) => b.status === 'pending_payment'), 'a declined card never confirms the booking (ID-53)');
  const log = await t.pool.query("SELECT * FROM payments WHERE status='declined'");
  assert.equal(log.rowCount, 2, 'declined attempts are kept for audit');
  assert.ok(log.rows[0].booking_id, 'linked to the booking that is waiting for payment');
  // another cab of the same size is still free at that time
  const ok = await t.book(cust, book({ method: 'card', card: card() }, { pickupAt: day(5) }));
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

  const noCvv = await t.book(cust, book({ method: 'card', savedCardId: saved.body.card.id }, { pickupAt: day(6) }));
  assert.equal(noCvv.status, 400);
  const paid = await t.book(cust, book({ method: 'card', savedCardId: saved.body.card.id, cvv: '123' }, { pickupAt: day(6) }));
  assert.equal(paid.status, 201);
  assert.equal(paid.body.payment.cardBrandLabel, 'Mastercard');

  const other = await t.register({ fullName: 'Pat Other', email: 'pat@example.com', phone: '07700 900321', addressLine: '2 Road', city: 'London', postcode: 'N1 9GU', password: 'Passw0rd1234' });
  assert.equal(other.status, 201);
  const otherTok = await t.login('pat@example.com', 'Passw0rd1234');
  assert.equal((await t.call('DELETE', `/payments/cards/${saved.body.card.id}`, { token: otherTok })).status, 404, "cannot delete someone else's card");
  assert.equal((await t.call('DELETE', `/payments/cards/${saved.body.card.id}`, { token: cust })).status, 200);
  assert.equal((await t.call('GET', '/payments/cards', { token: cust })).body.cards.length, 0);
});

test('US1.4 "save this card" while paying stores only the masked card', async () => {
  const r = await t.book(cust, book({ method: 'card', card: card({ number: '3782 822463 10005', cvv: '1234' }), saveCard: true }, { pickupAt: day(7) }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const cards = (await t.call('GET', '/payments/cards', { token: cust })).body.cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].brand, 'amex');
  assert.equal(cards[0].last4, '0005');
});

test('ID-55 PayPal: the booking waits, the customer approves on PayPal and comes back; cancel and reuse fail', async () => {
  const q = book({ method: 'paypal' }, { pickupAt: day(8), acceptTerms: true });
  const start = await t.call('POST', '/bookings', { token: cust, body: q });
  assert.equal(start.status, 202);
  assert.equal(start.body.booking.status, 'pending_payment');
  const a = start.body.nextAction;
  assert.equal(a.type, 'redirect');
  assert.equal(a.provider, 'paypal');
  const notApproved = await t.call('POST', `/bookings/${a.bookingId}/redirect-complete`, { token: cust, body: { token: a.token } });
  assert.equal(notApproved.status, 402);
  const info = await t.call('GET', `/payments/redirect/${a.token}`, { token: cust });
  assert.equal(info.body.amount, start.body.booking.price.total);
  assert.equal((await t.call('POST', `/payments/redirect/${a.token}/approve`, { token: cust, body: { email: 'bad' } })).status, 400);
  await t.call('POST', `/payments/redirect/${a.token}/approve`, { token: cust, body: { email: 'alex@paypal.example' } });
  const ok = await t.call('POST', `/bookings/${a.bookingId}/redirect-complete`, { token: cust, body: { token: a.token } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.booking.status, 'confirmed');
  assert.equal(ok.body.payment.method, 'paypal');
  assert.equal(ok.body.payment.paypalPayer, 'alex@paypal.example');
  const reuse = await t.call('POST', `/bookings/${a.bookingId}/redirect-complete`, { token: cust, body: { token: a.token } });
  assert.equal(reuse.status, 409, 'a PayPal approval can only be used once');

  const second = await t.call('POST', '/bookings', { token: cust, body: { ...q, pickupAt: day(9) } });
  await t.call('POST', `/payments/redirect/${second.body.nextAction.token}/cancel`, { token: cust });
  const cancelled = await t.call('POST', `/bookings/${second.body.nextAction.bookingId}/redirect-complete`, { token: cust, body: { token: second.body.nextAction.token } });
  assert.equal(cancelled.status, 402);
  assert.match(cancelled.body.error.message, /cancelled/);
  assert.equal((await t.call('POST', `/bookings/${second.body.booking.id}/abandon`, { token: cust })).status, 200);
  assert.equal((await t.call('GET', `/bookings/${second.body.booking.id}`, { token: cust })).body.booking.status, 'abandoned');
});

test('ID-57 pay from a bank account (simulated open banking)', async () => {
  const r = await t.book(cust, book({ method: 'bank' }, { pickupAt: day(10) }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.payment.method, 'bank');
  assert.equal(r.body.payment.bankName, 'Monzo');
});

test('ID-56 cash to the driver: confirmed at once, payment due at the end of the journey', async () => {
  const r = await t.book(cust, book({ method: 'cash' }, { pickupAt: day(11) }));
  assert.equal(r.status, 201);
  assert.equal(r.body.booking.status, 'confirmed');
  assert.equal(r.body.booking.paymentStatus, 'due_cash');
  assert.equal(r.body.payment, null);
});

test('ID-53 3D Secure: a card booking waits for the bank check; a wrong code keeps it pending; the right code confirms', async () => {
  const start = await t.call('POST', '/bookings', { token: cust, body: book({ method: 'card', card: card() }, { pickupAt: day(12), acceptTerms: true }) });
  assert.equal(start.status, 202);
  const a = start.body.nextAction;
  assert.equal(a.type, '3ds');
  assert.equal(a.last4, '4242');
  assert.equal(start.body.booking.status, 'pending_payment');
  assert.ok(start.body.booking.holdExpiresAt, 'the cab is held while the customer pays');
  const wrong = await t.call('POST', `/bookings/${a.bookingId}/3ds`, { token: cust, body: { challengeId: a.challengeId, code: '000000' } });
  assert.equal(wrong.status, 402);
  assert.equal(wrong.body.error.code, 'sca_wrong_code');
  assert.equal((await t.call('GET', `/bookings/${a.bookingId}`, { token: cust })).body.booking.status, 'pending_payment');
  const ok = await t.call('POST', `/bookings/${a.bookingId}/3ds`, { token: cust, body: { challengeId: a.challengeId, code: '123456' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.booking.status, 'confirmed');
  assert.equal(ok.body.payment.scaVerified, true);
  const { rows } = await t.pool.query("SELECT count(*)::int AS n FROM payments WHERE booking_id=$1 AND status='declined'", [a.bookingId]);
  assert.equal(rows[0].n, 1, 'the failed check is kept as an audit record');
});

test('ID-54 a declined card cannot confirm the booking; retry with another card keeps the journey details', async () => {
  const r = await t.book(cust, book({ method: 'card', card: card({ number: '4000 0000 0000 0002' }) }, { pickupAt: day(13) }));
  assert.equal(r.status, 402);
  assert.equal(r.body.error.code, 'payment_declined');
  const mine = (await t.call('GET', '/bookings?when=upcoming', { token: cust })).body.bookings.find((b) => b.status === 'pending_payment');
  assert.ok(mine, 'the booking is still waiting for payment');
  const retry = await t.call('POST', `/bookings/${mine.id}/pay`, { token: cust, body: { payment: { method: 'card', card: card() } } });
  assert.equal(retry.status, 202);
  const done = await t.finishPayment(cust, retry);
  assert.equal(done.status, 201);
  assert.equal(done.body.booking.id, mine.id);
  assert.equal(done.body.booking.pickup, 'Camden Town');
});

test('ID-53 an unpaid booking releases its cab when the hold runs out', async () => {
  const start = await t.call('POST', '/bookings', { token: cust, body: book({ method: 'card', card: card() }, { pickupAt: day(14), acceptTerms: true }) });
  const id = start.body.booking.id;
  await t.pool.query("UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id=$1", [id]);
  const late = await t.call('POST', `/bookings/${id}/3ds`, { token: cust, body: { challengeId: start.body.nextAction.challengeId, code: '123456' } });
  assert.equal(late.status, 409);
  assert.equal((await t.pool.query('SELECT status FROM bookings WHERE id=$1', [id])).rows[0].status, 'abandoned');
});

test('US6.1 a customer cannot open someone else\'s receipt', async () => {
  const mine = (await t.call('GET', '/bookings?when=all', { token: cust })).body.bookings[0];
  const otherTok = await t.login('pat@example.com', 'Passw0rd1234');
  assert.equal((await t.call('GET', `/bookings/${mine.id}/receipt`, { token: otherTok })).status, 404);
});
