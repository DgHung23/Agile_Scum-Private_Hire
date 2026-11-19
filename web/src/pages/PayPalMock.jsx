import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { money } from '../format.js';
import { Alert, Loading, TextField, useLoad } from '../ui.jsx';
import { v } from '../validators.js';

/**
 * SIMULATED PayPal approval page (US5.4). A real build redirects to PayPal and returns via a callback URL;
 * here the customer approves or cancels and is returned to the booking with the result.
 */
export default function PayPalMock() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const nav = useNavigate();
  const { data, loading, error } = useLoad(() => api.get(`/payments/paypal/${token}`), [token]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (!token) return <div className="container page"><Alert tone="error">No PayPal payment to approve.</Alert></div>;
  if (loading) return <div className="container page"><Loading /></div>;
  if (error) return <div className="container page"><Alert tone="error">{error.message}</Alert></div>;

  const approve = async (e) => {
    e.preventDefault();
    const x = {};
    const em = v.email(email);
    if (em) x.email = em;
    if (!password) x.password = 'Password is required';
    setErrs(x);
    if (Object.keys(x).length) return;
    setBusy(true);
    try {
      await api.post(`/payments/paypal/${token}/approve`, { email });
      nav('/book', { replace: true, state: { paypal: { token, status: 'approved', payer: email } } });
    } catch (e2) {
      setErr(e2.message);
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    await api.post(`/payments/paypal/${token}/cancel`).catch(() => {});
    nav('/book', { replace: true, state: { paypal: { status: 'cancelled' } } });
  };

  return (
    <div className="container page">
      <div className="narrow card card-elevated stack-lg">
        <div className="center stack-sm">
          <div className="strong" style={{ fontSize: 28, letterSpacing: -0.5 }}>PayPal</div>
          <span className="badge amber" style={{ alignSelf: 'center' }}>Simulated for this prototype - no real money moves</span>
        </div>
        <div className="center">
          <p className="muted small">Pay PrivateHire Cars</p>
          <p style={{ fontSize: 32, fontWeight: 700 }}>{money(data.amount)}</p>
        </div>
        <form className="stack" onSubmit={approve} noValidate>
          {err && <Alert tone="error">{err}</Alert>}
          <TextField label="PayPal email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} error={errs.email} hint="Use any email address" />
          <TextField label="Password" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} error={errs.password} hint="Use any password" />
          <button className="btn btn-lg btn-block" disabled={busy}>Log in and approve payment</button>
        </form>
        <button className="btn btn-ghost btn-block" onClick={cancel} disabled={busy}>Cancel and return to PrivateHire</button>
      </div>
    </div>
  );
}
