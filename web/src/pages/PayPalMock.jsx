import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { money } from '../format.js';
import { Alert, Loading, SelectField, TextField, useLoad } from '../ui.jsx';
import { v } from '../validators.js';

/**
 * SIMULATED provider page for PayPal (ID-55) and pay-by-bank (ID-57). A real build redirects to the provider and
 * returns via a callback URL; here the customer approves or cancels and goes back to the booking with the result.
 */
export default function ProviderMock() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const back = params.get('return') || '/book';
  const nav = useNavigate();
  const { data, loading, error } = useLoad(() => api.get(`/payments/redirect/${token}`), [token]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [bank, setBank] = useState('');
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (!token) return <div className="container page"><Alert tone="error">No payment to approve.</Alert></div>;
  if (loading) return <div className="container page"><Loading /></div>;
  if (error) return <div className="container page"><Alert tone="error">{error.message}</Alert></div>;
  const paypal = data.provider === 'paypal';
  const done = (status) =>
    nav(back.startsWith('/') ? back : '/book', { replace: true, state: { redirect: { token, bookingId: data.bookingId, status } } });

  const approve = async (e) => {
    e.preventDefault();
    const x = {};
    if (paypal) {
      const em = v.email(email);
      if (em) x.email = em;
      if (!password) x.password = 'Password is required';
    } else if (!bank) x.bank = 'Choose your bank';
    setErrs(x);
    if (Object.keys(x).length) return;
    setBusy(true);
    try {
      await api.post(`/payments/redirect/${token}/approve`, paypal ? { email } : { bankName: bank });
      done('approved');
    } catch (e2) {
      setErr(e2.message);
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    await api.post(`/payments/redirect/${token}/cancel`).catch(() => {});
    done('cancelled');
  };

  return (
    <div className="container page">
      <div className="narrow card card-elevated stack-lg">
        <div className="center stack-sm">
          <div className="strong" style={{ fontSize: 28, letterSpacing: -0.5 }}>{paypal ? 'PayPal' : 'Pay by bank'}</div>
          <span className="badge amber" style={{ alignSelf: 'center' }}>Simulated for this prototype - no real money moves</span>
        </div>
        <div className="center">
          <p className="muted small">Pay Private Hire Cars{data.ref ? ` for booking ${data.ref}` : ''}</p>
          <p style={{ fontSize: 32, fontWeight: 700 }}>{money(data.amount)}</p>
        </div>
        <form className="stack" onSubmit={approve} noValidate>
          {err && <Alert tone="error">{err}</Alert>}
          {paypal ? (
            <>
              <TextField label="PayPal email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} error={errs.email} hint="Use any email address" />
              <TextField label="Password" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} error={errs.password} hint="Use any password" />
            </>
          ) : (
            <SelectField label="Your bank" value={bank} onChange={(e) => setBank(e.target.value)} error={errs.bank}>
              <option value="">Choose your bank</option>
              {data.banks.map((b) => <option key={b} value={b}>{b}</option>)}
            </SelectField>
          )}
          <button className="btn btn-lg btn-block" disabled={busy}>{paypal ? 'Log in and approve payment' : 'Approve in my banking app'}</button>
        </form>
        <button className="btn btn-ghost btn-block" onClick={cancel} disabled={busy}>Cancel and return to Private Hire</button>
      </div>
    </div>
  );
}
