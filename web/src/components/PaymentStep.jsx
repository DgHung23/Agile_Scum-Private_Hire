import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { money } from '../format.js';
import { Alert } from '../ui.jsx';
import CardForm, { BLANK_CARD } from './CardForm.jsx';
import { onlyDigits, parseExpiry, validateCardForm } from '../validators.js';

/**
 * Payment choices for a booking: saved card, new card, or PayPal (US5.3, US5.4, US1.4).
 * Card details are kept in React state only and are sent once to the API - never stored in the browser.
 * `onSubmit(paymentPayload)` returns a promise. `serverErrors` are API field errors keyed like `payment.card.number`.
 */
export default function PaymentStep({ amount, paypal, onPayPal, onSubmit, busy, serverErrors = {}, allowSave = true, submitLabel }) {
  const [cards, setCards] = useState(null);
  const [method, setMethod] = useState(paypal?.token ? 'paypal' : 'card');
  const [choice, setChoice] = useState('new'); // 'new' or a saved card id
  const [card, setCard] = useState(BLANK_CARD);
  const [savedCvv, setSavedCvv] = useState('');
  const [saveCard, setSaveCard] = useState(false);
  const [errors, setErrors] = useState({});
  const [ppBusy, setPpBusy] = useState(false);

  useEffect(() => {
    api.get('/payments/cards').then((r) => {
      setCards(r.cards);
      const usable = r.cards.find((c) => !c.expired);
      if (usable) setChoice(usable.id);
    }).catch(() => setCards([]));
  }, []);

  useEffect(() => {
    const e = {};
    for (const [k, msg] of Object.entries(serverErrors)) {
      if (k.startsWith('payment.card.')) e[k.replace('payment.card.', '').replace('expYear', 'expiry').replace('expMonth', 'expiry')] = msg;
      if (k === 'payment.cvv') e.savedCvv = msg;
    }
    if (Object.keys(e).length) setErrors(e);
  }, [serverErrors]);

  const submit = async (ev) => {
    ev.preventDefault();
    setErrors({});
    if (method === 'paypal') {
      if (!paypal?.token) return setErrors({ paypal: 'Approve the payment in PayPal first' });
      return onSubmit({ method: 'paypal', token: paypal.token });
    }
    if (choice !== 'new') {
      const c = cards.find((x) => x.id === choice);
      const want = c.brand === 'amex' ? 4 : 3;
      if (!(want === 4 ? /^\d{4}$/ : /^\d{3}$/).test(savedCvv)) return setErrors({ savedCvv: `Security code must be ${want} digits` });
      return onSubmit({ method: 'card', savedCardId: choice, cvv: savedCvv });
    }
    const errs = validateCardForm(card);
    if (Object.keys(errs).length) {
      setErrors(errs);
      return;
    }
    const { expMonth, expYear } = parseExpiry(card.expiry);
    return onSubmit({
      method: 'card',
      card: { number: onlyDigits(card.number), expMonth, expYear, cvv: card.cvv, holder: card.holder.trim() },
      saveCard,
    });
  };

  const startPayPal = async () => {
    setPpBusy(true);
    try {
      await onPayPal();
    } finally {
      setPpBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="card stack">
        <h3>Pay for your booking</h3>
        <div className="option-grid">
          <button type="button" className={`option ${method === 'card' ? 'selected' : ''}`} aria-pressed={method === 'card'} onClick={() => setMethod('card')}>
            <span className="o-icon"><Icon name="card" /></span>
            <span><div className="o-title">Credit or debit card</div><div className="o-sub">Visa, Mastercard, American Express</div></span>
          </button>
          <button type="button" className={`option ${method === 'paypal' ? 'selected' : ''}`} aria-pressed={method === 'paypal'} onClick={() => setMethod('paypal')}>
            <span className="o-icon"><Icon name="lock" /></span>
            <span><div className="o-title">PayPal</div><div className="o-sub">Pay without entering card details</div></span>
          </button>
        </div>

        {method === 'card' && (
          <div className="stack">
            {cards && cards.length > 0 && (
              <div className="stack-sm">
                <div className="label">Your saved cards</div>
                {cards.map((c) => (
                  <label key={c.id} className={`option ${choice === c.id ? 'selected' : ''}`} style={{ cursor: c.expired ? 'not-allowed' : 'pointer', opacity: c.expired ? 0.5 : 1 }}>
                    <input type="radio" name="card-choice" checked={choice === c.id} disabled={c.expired} onChange={() => setChoice(c.id)} style={{ accentColor: '#ff385c', width: 20, height: 20 }} />
                    <span className="grow">
                      <div className="o-title">{c.brandLabel} ending {c.last4}</div>
                      <div className="o-sub">{c.expired ? 'Expired' : `Expires ${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}`}</div>
                    </span>
                  </label>
                ))}
                <label className={`option ${choice === 'new' ? 'selected' : ''}`}>
                  <input type="radio" name="card-choice" checked={choice === 'new'} onChange={() => setChoice('new')} style={{ accentColor: '#ff385c', width: 20, height: 20 }} />
                  <span className="o-title">Use a different card</span>
                </label>
              </div>
            )}
            {choice !== 'new' ? (
              <div className="field" style={{ maxWidth: 220 }}>
                <label htmlFor="saved-cvv">Security code</label>
                <input id="saved-cvv" className={`input`} inputMode="numeric" value={savedCvv} maxLength={4} aria-invalid={!!errors.savedCvv}
                  onChange={(e) => setSavedCvv(e.target.value.replace(/\D/g, ''))} autoComplete="cc-csc" />
                {errors.savedCvv && <span className="field-error" role="alert">{errors.savedCvv}</span>}
              </div>
            ) : (
              <>
                <CardForm value={card} onChange={setCard} errors={errors} />
                {allowSave && (
                  <label className="check">
                    <input type="checkbox" checked={saveCard} onChange={(e) => setSaveCard(e.target.checked)} />
                    <span>Save this card for next time <span className="muted small">(only the last 4 digits and expiry are kept)</span></span>
                  </label>
                )}
              </>
            )}
            <details className="small muted">
              <summary style={{ cursor: 'pointer' }}>Prototype: test card numbers</summary>
              <p style={{ marginTop: 8 }}>
                Visa <span className="kbd">4242 4242 4242 4242</span> &middot; Mastercard <span className="kbd">5555 5555 5555 4444</span> &middot;
                Amex <span className="kbd">3782 822463 10005</span><br />
                Declined <span className="kbd">4000 0000 0000 0002</span> &middot; No funds <span className="kbd">4000 0000 0000 9995</span>. Use any future
                expiry, any 3-digit code (4 for Amex).
              </p>
            </details>
          </div>
        )}

        {method === 'paypal' && (
          <div className="stack">
            {paypal?.token ? (
              <Alert tone="success">PayPal payment approved{paypal.payer ? ` for ${paypal.payer}` : ''}. Press the button below to complete your booking.</Alert>
            ) : (
              <>
                <p className="muted small">You will be taken to PayPal to approve {money(amount)}, then brought straight back here.</p>
                <button type="button" className="btn btn-secondary" onClick={startPayPal} disabled={ppBusy}>{ppBusy ? 'Opening PayPal...' : 'Continue to PayPal'}</button>
                {errors.paypal && <span className="field-error" role="alert">{errors.paypal}</span>}
              </>
            )}
          </div>
        )}
      </div>

      <p className="tiny center"><Icon name="lock" size={12} /> Card details are sent securely and checked with the bank before your booking is confirmed.</p>
      <button className="btn btn-lg btn-block" disabled={busy || (method === 'paypal' && !paypal?.token)}>
        {busy ? 'Processing payment...' : submitLabel || `Pay ${money(amount)} and confirm`}
      </button>
    </form>
  );
}
