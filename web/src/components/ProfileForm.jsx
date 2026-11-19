import { useState } from 'react';
import { Alert, SelectField, TextField } from '../ui.jsx';
import { passwordStrength, v, validate } from '../validators.js';
import { Icon } from '../icons.jsx';

const BLANK = { fullName: '', email: '', phone: '', addressLine: '', city: '', postcode: '', notifyPref: 'email', password: '' };

/**
 * One form for registering, editing a profile and (later) staff creating an account for a caller.
 * US1.1 / US1.5 / US9.3 share the same validation, client-side here and server-side in the API.
 */
export default function ProfileForm({ initial, withPassword = false, submitLabel, onSubmit, onCancel }) {
  const [values, setValues] = useState({ ...BLANK, ...initial });
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [showPw, setShowPw] = useState(false);

  const rules = {
    fullName: v.required('Full name'),
    email: v.email,
    phone: v.phone,
    addressLine: v.required('Address'),
    city: v.required('City'),
    postcode: v.postcode,
    ...(withPassword ? { password: v.password } : {}),
  };

  const set = (k) => (e) => {
    const val = e.target.value;
    setValues((s) => ({ ...s, [k]: val }));
    if (touched[k]) setErrors((s) => ({ ...s, [k]: rules[k]?.(val) || '' }));
  };
  const blur = (k) => () => {
    setTouched((s) => ({ ...s, [k]: true }));
    setErrors((s) => ({ ...s, [k]: rules[k]?.(values[k]) || '' }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setFormError('');
    const errs = validate(values, rules);
    setErrors(errs);
    setTouched(Object.fromEntries(Object.keys(rules).map((k) => [k, true])));
    if (Object.keys(errs).length) {
      setFormError('Please fix the highlighted fields.');
      document.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    setBusy(true);
    try {
      await onSubmit(values);
    } catch (err) {
      if (err.fields && Object.keys(err.fields).length) setErrors((s) => ({ ...s, ...err.fields }));
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const strength = passwordStrength(values.password);

  return (
    <form onSubmit={submit} noValidate className="stack">
      {formError && <Alert tone="error">{formError}</Alert>}
      <div className="form-grid two">
        <TextField className="span-2" label="Full name" autoComplete="name" value={values.fullName} onChange={set('fullName')} onBlur={blur('fullName')} error={errors.fullName} />
        <TextField label="Email" type="email" autoComplete="email" inputMode="email" value={values.email} onChange={set('email')} onBlur={blur('email')} error={errors.email} />
        <TextField label="Telephone" type="tel" autoComplete="tel" inputMode="tel" value={values.phone} onChange={set('phone')} onBlur={blur('phone')} error={errors.phone} hint="Used for text updates about your driver" />
        <TextField className="span-2" label="Address" autoComplete="street-address" value={values.addressLine} onChange={set('addressLine')} onBlur={blur('addressLine')} error={errors.addressLine} />
        <TextField label="City" autoComplete="address-level2" value={values.city} onChange={set('city')} onBlur={blur('city')} error={errors.city} />
        <TextField label="Postcode" autoComplete="postal-code" value={values.postcode} onChange={set('postcode')} onBlur={blur('postcode')} error={errors.postcode} />
        <SelectField className="span-2" label="How should we update you about journeys?" value={values.notifyPref} onChange={set('notifyPref')}>
          <option value="email">Email</option>
          <option value="text">Text message</option>
          <option value="both">Email and text message</option>
        </SelectField>
        {withPassword && (
          <div className="span-2 stack-sm">
            <div className="field">
              <label htmlFor="pf-password">Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="pf-password"
                  className="input"
                  type={showPw ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={values.password}
                  onChange={set('password')}
                  onBlur={blur('password')}
                  aria-invalid={!!errors.password}
                  style={{ paddingRight: 48 }}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ position: 'absolute', right: 4, top: 6 }}
                  onClick={() => setShowPw((s) => !s)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  <Icon name="eye" size={18} />
                </button>
              </div>
              {errors.password ? (
                <span className="field-error" role="alert">{errors.password}</span>
              ) : (
                <span className="field-hint">At least 8 characters with a letter and a number</span>
              )}
            </div>
            <div className="pwd-meter" aria-hidden="true">
              <div style={{ width: `${(strength / 4) * 100}%` }} />
            </div>
          </div>
        )}
      </div>
      <div className="row">
        <button className="btn btn-lg" type="submit" disabled={busy}>
          {busy ? 'Please wait...' : submitLabel}
        </button>
        {onCancel && (
          <button className="btn btn-lg btn-subtle" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
