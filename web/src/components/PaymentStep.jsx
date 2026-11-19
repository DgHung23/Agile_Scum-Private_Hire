import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { money } from '../format.js';
import { TextField } from '../ui.jsx';
import CardForm, { BLANK_CARD } from './CardForm.jsx';
import { onlyDigits, parseExpiry, validateCardForm } from '../validators.js';

const METHODS = [
  ['card', 'card', 'Credit or debit card', 'Visa, Mastercard, American Express'],
  ['paypal', 'lock', 'PayPal', 'Approve on PayPal, then come back'],
  ['bank', 'building', 'Pay by bank', 'Approve in your banking app'],
  ['cash', 'tag', 'Cash to the driver', 'Pay at the end of the journey'],
];

/**
 * Payment choices for a booking (ID-53 card, ID-55 PayPal, ID-56 cash, ID-57 bank, ID-14 saved cards).
 * Card details stay in React state and are sent once to the API - never stored in the browser.
 * `onSubmit(paymentPayload)` returns a promise. `serverErrors` are API field errors keyed like `payment.card.number`.
 */
export default function PaymentStep({ amount, onSubmit, busy, serverErrors = {}, allowSave = true, submitLabel }) {
  const [cards, setCards] = useState(null);
  const [method, setMethod] = useState('card');
  const [choice, setChoice] = useState('new'); // 'new' or a saved card id
  const [card, setCard] = useState(BLANK_CARD);
  const [savedCvv, setSavedCvv] = useState('');
  const [saveCard, setSaveCard] = useState(false);
  const [errors, setErrors] = useState({});
  const [company, setCompany] = useState(null);
  const [costCentre, setCostCentre] = useState('');

  // N09: Business Bookers can put the journey on the company account.
  useEffect(() => {
    api.get('/business/me').then((r) => setCompany(r.company && ['approved', 'suspended'].includes(r.company.status) ? r.company : null)).catch(() => {});
  }, []);

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
    if (method === 'invoice') return onSubmit({ method, ...(costCentre.trim() ? { costCentre: costCentre.trim() } : {}) });
    if (method !== 'card') return onSubmit({ method });
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

  const label =
    method === 'invoice'
      ? `Confirm on the company account - ${money(amount)}`
      : method === 'cash'
      ? `Confirm booking - pay ${money(amount)} to the driver`
      : method === 'paypal'
        ? `Continue to PayPal - ${money(amount)}`
        : method === 'bank'
          ? `Continue to your bank - ${money(amount)}`
          : submitLabel || `Pay ${money(amount)} and confirm`;

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="card stack">
        <h3>Pay for your booking</h3>
        <div className="option-grid">
          {[...(company ? [['invoice', 'building', 'Company account', `${company.name} - monthly invoice`]] : []), ...METHODS].map(([m, icon, title, sub]) => (
            <button key={m} type="button" className={`option ${method === m ? 'selected' : ''}`} aria-pressed={method === m} onClick={() => setMethod(m)}>
              <span className="o-icon"><Icon name={icon} /></span>
              <span><div className="o-title">{title}</div><div className="o-sub">{sub}</div></span>
            </button>
          ))}
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
                <input id="saved-cvv" className="input" inputMode="numeric" value={savedCvv} maxLength={4} aria-invalid={!!errors.savedCvv}
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
                expiry, any 3-digit code (4 for Amex). The bank check code is <span className="kbd">123456</span>.
              </p>
            </details>
          </div>
        )}
        {method === 'invoice' && (
          <div className="stack-sm">
            {company.status === 'suspended' && <p className="small" style={{ color: '#c13515' }}>Your company account is suspended. Please pay by card this time.</p>}
            <TextField label="Cost-centre reference (optional)" value={costCentre} onChange={(e) => setCostCentre(e.target.value)} hint="Shown on your receipt and the company invoice" />
          </div>
        )}
        {method === 'cash' && <p className="muted small">Your booking is confirmed now. Pay the driver {money(amount)} in cash when the journey ends; your receipt follows.</p>}
        {(method === 'paypal' || method === 'bank') && (
          <p className="muted small">We hold your cab while you approve {money(amount)} with {method === 'paypal' ? 'PayPal' : 'your bank'}, then bring you straight back.</p>
        )}
      </div>

      <p className="tiny center"><Icon name="lock" size={12} /> Card payments are confirmed with your bank (3D Secure) before your booking is confirmed.</p>
      <button className="btn btn-lg btn-block" disabled={busy}>{busy ? 'Processing payment...' : label}</button>
    </form>
  );
}
