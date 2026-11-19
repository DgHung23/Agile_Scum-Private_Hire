import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Icon } from '../icons.jsx';
import { fmtDate, fmtDateTime } from '../format.js';
import { Alert, Field, Loading, SelectField, TextArea, TextField, useLoad } from '../ui.jsx';
import { v, validate } from '../validators.js';

/** US2.1 general enquiry (anyone) and US2.2 enquiry about one of my trips (logged-in customers). */
export default function Contact() {
  const { user } = useAuth();
  const customer = user?.role === 'customer';
  const [params] = useSearchParams();
  const trips = useLoad(() => (customer ? api.get('/bookings?when=all') : Promise.resolve({ bookings: [] })), [customer]);
  const mine = useLoad(() => (customer ? api.get('/enquiries/mine') : Promise.resolve({ enquiries: [] })), [customer]);
  const [f, setF] = useState({ name: '', email: '', subject: '', message: '', bookingId: params.get('booking') || '' });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);

  useEffect(() => {
    if (user) setF((s) => ({ ...s, name: s.name || user.fullName, email: s.email || user.email }));
  }, [user]);

  const set = (k) => (e) => {
    setF((s) => ({ ...s, [k]: e.target.value }));
    setErrors((x) => ({ ...x, [k]: '' }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const errs = validate(f, {
      name: v.required('Name'),
      email: v.email,
      subject: v.required('Subject'),
      message: v.required('Message'),
    });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const r = await api.post('/enquiries', { ...f, bookingId: f.bookingId || null });
      setSent(r.enquiry);
      mine.reload?.();
    } catch (err) {
      setErrors(err.fields || {});
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="container page">
        <div className="narrow card card-elevated stack-lg center">
          <div className="stack-sm" style={{ alignItems: 'center' }}>
            <span className="avatar" style={{ width: 56, height: 56, background: 'var(--success-bg)', color: 'var(--success)' }}><Icon name="check" size={28} /></span>
            <h2>Thank you, we have your enquiry</h2>
            <p className="muted">Reference <span className="mono strong">{sent.ref}</span>. We have emailed a confirmation to {sent.email} and will reply by email.</p>
          </div>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn" onClick={() => { setSent(null); setF((s) => ({ ...s, subject: '', message: '', bookingId: '' })); }}>Send another</button>
            <Link to={user ? '/dashboard' : '/'} className="btn btn-subtle">Back</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container page">
      <div className="medium stack-lg">
        <div>
          <h1 style={{ fontSize: 'clamp(30px,4vw,44px)' }}>Help and enquiries</h1>
          <p className="muted" style={{ marginTop: 8, fontSize: 18 }}>Ask us anything about our services or a booking. We reply by email. Prefer to talk? Call <a href="tel:+442070000000" className="strong">020 7000 0000</a>.</p>
        </div>
        <form className="card stack" onSubmit={submit} noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          {customer && (
            <SelectField label="What is your enquiry about?" value={f.bookingId} onChange={set('bookingId')} error={errors.bookingId}>
              <option value="">A general question</option>
              {trips.data?.bookings.map((b) => <option key={b.id} value={b.id}>{b.ref} - {fmtDateTime(b.pickupAt)} - {b.pickup} to {b.destination}</option>)}
            </SelectField>
          )}
          <div className="form-grid two">
            <TextField label="Your name" autoComplete="name" value={f.name} onChange={set('name')} error={errors.name} />
            <TextField label="Email" type="email" autoComplete="email" value={f.email} onChange={set('email')} error={errors.email} />
            <TextField className="span-2" label="Subject" value={f.subject} onChange={set('subject')} error={errors.subject} />
            <TextArea className="span-2" label="Message" value={f.message} onChange={set('message')} error={errors.message} maxLength={2000} />
          </div>
          {!customer && <p className="small muted">Asking about a trip you have booked? <Link to="/login" state={{ from: '/contact' }} className="strong">Log in</Link> to pick the booking.</p>}
          <div><button className="btn btn-lg" disabled={busy}>{busy ? 'Sending...' : 'Send enquiry'}</button></div>
        </form>

        {customer && (
          <section className="stack">
            <h3>Your enquiries</h3>
            {mine.loading && <Loading />}
            {mine.data?.enquiries.length === 0 && <p className="muted small">You have not sent any enquiries yet.</p>}
            {mine.data?.enquiries.map((e) => (
              <div key={e.id} className="card stack-sm">
                <div className="row-between">
                  <div className="strong">{e.subject}</div>
                  <span className={`badge ${e.status === 'replied' ? 'green' : 'amber'}`}>{e.status === 'replied' ? 'Replied' : 'Waiting for a reply'}</span>
                </div>
                <div className="tiny">{e.ref} &middot; {fmtDate(e.createdAt)}{e.bookingRef ? ` · about booking ${e.bookingRef}` : ''}</div>
                <p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{e.message}</p>
                {e.replies.map((r) => (
                  <div key={r.id} className="msg">
                    <div className="meta">{r.staffName}, Private Hire - {fmtDate(r.createdAt)}</div>
                    <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{r.body}</p>
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
