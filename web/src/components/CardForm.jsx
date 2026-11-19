import { BRAND_NAME, cardBrand, formatCardNumber, formatExpiry } from '../validators.js';
import { Field } from '../ui.jsx';
import { Icon } from '../icons.jsx';

export const BLANK_CARD = { number: '', expiry: '', cvv: '', holder: '' };

/** Controlled card entry fields. `errors` keys: number, expiry, cvv, holder. Card data lives only in component state. */
export default function CardForm({ value, onChange, errors = {} }) {
  const brand = cardBrand(value.number);
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <div className="form-grid two">
      <Field className="span-2" label="Card number" error={errors.number}>
        {(id) => (
          <div style={{ position: 'relative' }}>
            <input id={id} className="input" inputMode="numeric" autoComplete="cc-number" placeholder="1234 5678 9012 3456"
              value={value.number} aria-invalid={!!errors.number} style={{ paddingRight: 130 }}
              onChange={(e) => set('number', formatCardNumber(e.target.value))} />
            <span className="badge" style={{ position: 'absolute', right: 10, top: 12, background: brand ? 'var(--ink)' : 'var(--pressed)', color: brand ? '#fff' : 'var(--body)' }}>
              <Icon name="card" size={14} /> {brand ? BRAND_NAME[brand] : 'Visa / MC / Amex'}
            </span>
          </div>
        )}
      </Field>
      <Field label="Expiry (MM/YY)" error={errors.expiry}>
        {(id) => (
          <input id={id} className="input" inputMode="numeric" autoComplete="cc-exp" placeholder="MM/YY" value={value.expiry}
            aria-invalid={!!errors.expiry} onChange={(e) => set('expiry', formatExpiry(e.target.value))} />
        )}
      </Field>
      <Field label={brand === 'amex' ? 'Security code (4 digits)' : 'Security code (3 digits)'} error={errors.cvv}>
        {(id) => (
          <input id={id} className="input" inputMode="numeric" autoComplete="cc-csc" placeholder={brand === 'amex' ? '1234' : '123'}
            value={value.cvv} maxLength={4} aria-invalid={!!errors.cvv} onChange={(e) => set('cvv', e.target.value.replace(/\D/g, ''))} />
        )}
      </Field>
      <Field className="span-2" label="Name on card" error={errors.holder}>
        {(id) => (
          <input id={id} className="input" autoComplete="cc-name" value={value.holder} aria-invalid={!!errors.holder}
            onChange={(e) => set('holder', e.target.value)} />
        )}
      </Field>
    </div>
  );
}
