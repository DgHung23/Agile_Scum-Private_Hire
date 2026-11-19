import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { isStaffRole, useAuth } from '../auth.jsx';
import { Alert, TextField } from '../ui.jsx';
import { v, validate } from '../validators.js';
import ProfileForm from '../components/ProfileForm.jsx';

function LoginForm({ staff }) {
  const { login, user } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [f, setF] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const destFor = (u) => {
    const from = loc.state?.from;
    if (from && !!isStaffRole(u) === from.startsWith('/staff')) return from;
    return isStaffRole(u) ? '/staff' : '/dashboard';
  };
  if (user) return <Navigate to={destFor(user)} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const errs = validate(f, { email: v.email, password: (x) => (x ? '' : 'Password is required') });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const u = await login(f.email.trim(), f.password, { staff });
      nav(destFor(u), { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="stack">
      {loc.state?.registered && (
        <Alert tone="success">
          Your account is ready. We have emailed a confirmation to <strong>{loc.state.registered}</strong>. Log in to start
          booking.
        </Alert>
      )}
      {loc.state?.reset && <Alert tone="success">Your password has been changed. Log in with your new password.</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      <TextField label="Email" type="email" autoComplete="email" inputMode="email" value={f.email} error={errors.email}
        onChange={(e) => setF({ ...f, email: e.target.value })} />
      <TextField label="Password" type="password" autoComplete="current-password" value={f.password} error={errors.password}
        onChange={(e) => setF({ ...f, password: e.target.value })} />
      <button className="btn btn-lg btn-block" disabled={busy}>
        {busy ? 'Logging in...' : staff ? 'Sign in to staff area' : 'Log in'}
      </button>
    </form>
  );
}

export function Login() {
  return (
    <div className="container page">
      <div className="narrow card card-elevated stack-lg">
        <div>
          <h2>Welcome back</h2>
          <p className="muted" style={{ marginTop: 6 }}>Log in to book, manage your trips and see your offers.</p>
        </div>
        <LoginForm />
        <div className="stack-sm center small">
          <span><Link to="/forgot-password" className="strong">Forgot your password?</Link></span>
          <span className="muted">New here? <Link to="/register" className="strong">Create an account</Link></span>
          <span className="muted">Staff? <Link to="/staff/login" className="strong">Staff sign in</Link></span>
        </div>
        <details className="small muted">
          <summary style={{ cursor: 'pointer' }}>Demo account</summary>
          <p style={{ marginTop: 8 }}>customer@privatehire.test / Customer123!</p>
        </details>
      </div>
    </div>
  );
}

export function StaffLogin() {
  return (
    <div className="container page">
      <div className="narrow card card-elevated stack-lg">
        <div>
          <h2>Staff sign in</h2>
          <p className="muted" style={{ marginTop: 6 }}>Call-centre, control-centre and manager access.</p>
        </div>
        <LoginForm staff />
        <p className="small center muted">Customer? <Link to="/login" className="strong">Log in here</Link></p>
        <details className="small muted">
          <summary style={{ cursor: 'pointer' }}>Demo accounts</summary>
          <p style={{ marginTop: 8 }}>Staff: staff@privatehire.test / Staff123!<br />Manager: admin@privatehire.test / Admin123!</p>
        </details>
      </div>
    </div>
  );
}

export function Register() {
  const nav = useNavigate();
  const { user } = useAuth();
  if (user) return <Navigate to="/dashboard" replace />;
  return (
    <div className="container page">
      <div className="medium card card-elevated stack-lg">
        <div>
          <h2>Create your account</h2>
          <p className="muted" style={{ marginTop: 6 }}>
            Registered customers save 15% on every online booking and get priority service.
          </p>
        </div>
        <ProfileForm
          withPassword
          submitLabel="Create account"
          onSubmit={async (values) => {
            await api.post('/auth/register', values);
            nav('/login', { replace: true, state: { registered: values.email } });
          }}
        />
        <p className="small center muted">Already registered? <Link to="/login" className="strong">Log in</Link></p>
      </div>
    </div>
  );
}

/** US1.6: ask for a reset link. The answer is the same whether or not the email is registered. */
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const m = v.email(email);
    if (m) return setErr(m);
    setErr('');
    setBusy(true);
    try {
      await api.post('/auth/forgot', { email: email.trim() });
      setSent(true);
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="container page">
      <div className="narrow card card-elevated stack-lg">
        <div>
          <h2>Reset your password</h2>
          <p className="muted" style={{ marginTop: 6 }}>Enter your email and we will send you a link to choose a new password.</p>
        </div>
        {sent ? (
          <Alert tone="success">
            If that email is registered, we have sent a reset link. It works for 1 hour. In this prototype the email appears in{' '}
            <strong>Messages</strong> after you log in, or in the staff Outbox.
          </Alert>
        ) : (
          <form className="stack" onSubmit={submit} noValidate>
            <TextField label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={err} />
            <button className="btn btn-lg btn-block" disabled={busy}>{busy ? 'Sending...' : 'Send reset link'}</button>
          </form>
        )}
        <p className="small center"><Link to="/login" className="strong">Back to log in</Link></p>
      </div>
    </div>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const nav = useNavigate();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [errors, setErrors] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    const x = {};
    const m = v.password(pw);
    if (m) x.pw = m;
    if (pw2 !== pw) x.pw2 = 'The passwords do not match';
    setErrors(x);
    if (Object.keys(x).length) return;
    setBusy(true);
    try {
      await api.post('/auth/reset', { token, password: pw });
      nav('/login', { replace: true, state: { reset: true } });
    } catch (e2) {
      setErr(e2.message);
      setBusy(false);
    }
  };
  return (
    <div className="container page">
      <div className="narrow card card-elevated stack-lg">
        <h2>Choose a new password</h2>
        {!token && <Alert tone="error">This reset link is not valid. <Link to="/forgot-password" className="strong">Ask for a new one</Link>.</Alert>}
        {err && <Alert tone="error">{err} <Link to="/forgot-password" className="strong">Ask for a new link</Link></Alert>}
        <form className="stack" onSubmit={submit} noValidate>
          <TextField label="New password" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} error={errors.pw} hint="At least 8 characters with a letter and a number" />
          <TextField label="Repeat new password" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} error={errors.pw2} />
          <button className="btn btn-lg btn-block" disabled={busy || !token}>{busy ? 'Saving...' : 'Change password'}</button>
        </form>
      </div>
    </div>
  );
}
