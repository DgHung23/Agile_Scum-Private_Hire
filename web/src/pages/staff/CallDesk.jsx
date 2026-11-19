import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { CHANNEL_LABEL, fmtDate, fmtDateTime, money } from '../../format.js';
import { Alert, Empty, Kv, Loading, Modal, PageHeader, StatusBadge, TextArea, TextField, useLoad, useToast } from '../../ui.jsx';
import ProfileForm from '../../components/ProfileForm.jsx';

/* ---------- 1. find the caller ---------- */
export function CallDesk() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const search = async (e) => {
    e.preventDefault();
    setError('');
    if (q.trim().length < 2) return setError('Type at least 2 characters: name, phone, email or booking reference.');
    setBusy(true);
    try {
      setResults((await api.get('/staff/customers/search' + qs({ q: q.trim() }))).customers);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-lg">
      <PageHeader title="Call desk" sub="Find the caller, verify who they are, then book for them."
        actions={<Link to="/staff/call-desk/new" className="btn"><Icon name="plus" size={18} /> New caller</Link>} />
      <form className="row" style={{ alignItems: 'flex-end', flexWrap: 'nowrap' }} onSubmit={search} role="search">
        <div className="grow">
          <TextField label="Search customers" placeholder="Name, phone, email or booking reference" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn btn-lg" disabled={busy} style={{ marginBottom: 0 }}><Icon name="search" size={18} /> Search</button>
      </form>
      {error && <Alert tone="error">{error}</Alert>}
      {results && results.length === 0 && (
        <Empty icon="user" title="No customer found" action={<Link to="/staff/call-desk/new" className="btn">Create an account for this caller</Link>}>
          Check the spelling, or this may be a new customer.
        </Empty>
      )}
      <div className="stack">
        {results?.map((c) => (
          <button key={c.id} className="card clickable row-between" style={{ textAlign: 'left', font: 'inherit', width: '100%', cursor: 'pointer' }}
            onClick={() => nav(`/staff/call-desk/${c.id}`, { state: { name: c.fullName } })}>
            <div className="row" style={{ gap: 12 }}>
              <span className="avatar"><Icon name="user" size={16} /></span>
              <div>
                <div className="strong">{c.fullName}</div>
                <div className="small muted">{c.maskedEmail} &middot; {c.maskedPhone} &middot; {c.city}</div>
              </div>
            </div>
            <div className="small muted">{c.bookings} booking{c.bookings === 1 ? '' : 's'} <Icon name="arrow" size={14} /></div>
          </button>
        ))}
      </div>
      <p className="tiny">Personal details stay hidden until the caller has been verified.</p>
    </div>
  );
}

/* ---------- new caller (US9.3) ---------- */
export function NewCaller() {
  const nav = useNavigate();
  const toast = useToast();
  const [existing, setExisting] = useState(null);
  return (
    <div className="stack-lg medium" style={{ marginInline: 0 }}>
      <PageHeader title="New customer account" sub="Create an account for a caller who is not registered. They are emailed a confirmation." />
      {existing && (
        <Alert tone="warn" icon="alert">
          <strong>{existing.fullName}</strong> is already registered with that email.{' '}
          <Link to={`/staff/call-desk/${existing.id}`} state={{ name: existing.fullName }} className="strong">Verify the caller instead</Link>.
        </Alert>
      )}
      <div className="card">
        <ProfileForm
          withChannel
          submitLabel="Create account"
          onCancel={() => nav('/staff/call-desk')}
          onSubmit={async (v) => {
            try {
              const r = await api.post('/staff/customers', { ...v, notifyPref: v.notifyPref });
              toast('Account created and confirmation emailed', 'success');
              nav(`/staff/call-desk/${r.customer.id}`, { state: { name: r.customer.fullName } });
            } catch (e) {
              if (e.code === 'email_taken') setExisting(e.existing || null);
              throw e;
            }
          }}
        />
      </div>
    </div>
  );
}

/* ---------- 2. verify, then the customer record ---------- */
const QUESTIONS = [
  ['postcode', 'Postcode on the account', 'SW1A 1AA'],
  ['phoneLast4', 'Last 4 digits of their phone number', '0123'],
  ['houseNumber', 'House number or first line of address', '10'],
  ['email', 'Email address', 'name@example.com'],
  ['bookingRef', 'A recent booking reference', 'PH-ABC123'],
];

const RESULT_KEY = { phoneLast4: 'phone_last4', houseNumber: 'house_number', bookingRef: 'booking_ref' };
function matchBadge(results, question) {
  const key = RESULT_KEY[question] || question;
  if (!(key in results)) return null;
  return <span className={`badge ${results[key] ? 'green' : 'red'}`} style={{ marginTop: 6 }}>{results[key] ? 'Matches' : 'Does not match'}</span>;
}

function VerifyPanel({ id, name, onVerified }) {
  const [a, setA] = useState({});
  const [res, setRes] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const check = async (e, withConfirm = false) => {
    e?.preventDefault();
    setError('');
    const answers = Object.fromEntries(Object.entries(a).filter(([, v]) => v && v.trim()));
    if (Object.keys(answers).length < 2) return setError('Ask the caller at least two questions and enter their answers.');
    setBusy(true);
    try {
      const r = await api.post(`/staff/customers/${id}/verify`, { answers, confirmed: withConfirm });
      setRes(r);
      if (r.verified) onVerified();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-lg medium" style={{ marginInline: 0 }}>
      <PageHeader title={`Verify ${name || 'the caller'}`} sub="Ask the caller for at least two of these. Two must match before the account opens." />
      <form className="card stack" onSubmit={check} noValidate>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="form-grid two">
          {QUESTIONS.map(([k, label, ph]) => (
            <div key={k}>
              <TextField label={label} placeholder={ph} autoComplete="off" value={a[k] || ''} onChange={(e) => { setA({ ...a, [k]: e.target.value }); setRes(null); }} />
              {res?.results && matchBadge(res.results, k)}
            </div>
          ))}
        </div>
        {res && (
          <Alert tone={res.matched >= res.needed ? 'success' : 'warn'}>
            {res.matched} of {res.needed} required answers match.
            {res.matched < res.needed && ' Ask another question, or do not open the account.'}
          </Alert>
        )}
        {res && res.matched >= res.needed && !res.verified && (
          <label className="check">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span><strong>Identity verified</strong> - I am satisfied the caller is the account holder.</span>
          </label>
        )}
        <div className="row">
          <button className="btn" disabled={busy}>{busy ? 'Checking...' : 'Check answers'}</button>
          {res && res.matched >= res.needed && (
            <button type="button" className="btn btn-secondary" disabled={busy || !confirmed} onClick={() => check(null, true)}>Open account</button>
          )}
        </div>
      </form>
    </div>
  );
}

function CancelByStaff({ b, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true);
    try {
      onDone(await api.post(`/staff/bookings/${b.id}/cancel`, { reason }));
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Cancel ${b.ref}?`} onClose={onClose}
      footer={<><button className="btn btn-subtle" onClick={onClose} disabled={busy}>Keep it</button><button className="btn btn-danger" onClick={go} disabled={busy}>{busy ? 'Cancelling...' : 'Cancel booking'}</button></>}>
      {err && <Alert tone="error">{err}</Alert>}
      <p>{fmtDateTime(b.pickupAt)}<br />{b.pickup} to {b.destination}</p>
      <p className="small muted">Staff can cancel at any time. Anything paid is refunded and the customer is emailed.</p>
      <TextArea label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ minHeight: 70 }} />
    </Modal>
  );
}

export function CallDeskCustomer() {
  const { id } = useParams();
  const loc = useLocation();
  const toast = useToast();
  const { data, loading, error, reload } = useLoad(() => api.get(`/staff/customers/${id}`), [id]);
  const [cancel, setCancel] = useState(null);

  if (loading) return <Loading />;
  if (error?.code === 'not_verified') return <VerifyPanel id={id} name={loc.state?.name} onVerified={reload} />;
  if (error) return <Alert tone="error">{error.message}</Alert>;
  const c = data.customer;

  return (
    <div className="stack-lg">
      <div><Link to="/staff/call-desk" className="small strong">&larr; Call desk</Link></div>
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2>{c.fullName}</h2>
          <p className="muted"><span className="badge green"><Icon name="check" size={12} /> Identity verified</span> &nbsp;Verification lasts 30 minutes.</p>
        </div>
        <Link to={`/staff/call-desk/${id}/book`} state={{ name: c.fullName }} className="btn btn-lg"><Icon name="car" size={18} /> Book for {c.fullName.split(' ')[0]}</Link>
      </div>
      <div className="grid grid-3">
        <div className="card stack-sm">
          <h3>Contact</h3>
          <Kv k="Email" v={c.email} />
          <Kv k="Phone" v={c.phone} />
          <Kv k="Updates by" v={{ email: 'Email', text: 'Text', both: 'Email and text' }[c.notifyPref]} />
        </div>
        <div className="card stack-sm">
          <h3>Address</h3>
          <div>{c.addressLine}</div>
          <div className="muted">{c.city} {c.postcode}</div>
          <div className="tiny">Registered {fmtDate(c.createdAt)} ({CHANNEL_LABEL[c.signupChannel]})</div>
        </div>
        <div className="card stack-sm">
          <h3>Activity</h3>
          <Kv k="Trips" v={data.stats.trips} />
          <Kv k="Total spend" v={money(data.stats.spend)} />
        </div>
      </div>

      <section className="stack">
        <h3>Bookings</h3>
        {data.bookings.length === 0 && <Empty icon="calendar" title="No bookings yet" />}
        {data.bookings.map((b) => (
          <div key={b.id} className="card stack-sm">
            <div className="row-between" style={{ alignItems: 'flex-start' }}>
              <div>
                <div className="strong">{fmtDateTime(b.pickupAt)}</div>
                <div className="small muted">{b.service.label} &middot; {b.pickup} to {b.destination}</div>
              </div>
              <StatusBadge status={b.status} />
            </div>
            <div className="row-between small">
              <span className="mono muted">{b.ref} &middot; {CHANNEL_LABEL[b.channel]} &middot; {b.paymentStatus}</span>
              <span className="row">
                <strong>{money(b.price.total)}</strong>
                {['confirmed', 'assigned'].includes(b.status) && <button className="btn btn-subtle btn-sm" onClick={() => setCancel(b)}>Cancel</button>}
              </span>
            </div>
          </div>
        ))}
      </section>
      {cancel && <CancelByStaff b={cancel} onClose={() => setCancel(null)} onDone={(r) => { setCancel(null); toast(r.refund ? `Cancelled. ${money(r.refund.amount)} refunded.` : 'Cancelled.', 'success'); reload(); }} />}
    </div>
  );
}
