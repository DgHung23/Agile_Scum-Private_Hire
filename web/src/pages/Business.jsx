import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { fmtDate, fmtShort, money } from '../format.js';
import { Alert, Empty, Kv, Loading, Modal, PageHeader, TextField, useLoad, useToast } from '../ui.jsx';
import CardForm, { BLANK_CARD } from '../components/CardForm.jsx';
import { onlyDigits, parseExpiry, v, validate, validateCardForm } from '../validators.js';

const STATUS = { pending: ['amber', 'Waiting for approval'], approved: ['green', 'Active'], suspended: ['red', 'Suspended'], rejected: ['red', 'Not approved'], closed: ['', 'Closed'] };

/**
 * Business accounts (N06 to N12): apply, then (as Business Account Admin) invite bookers, see company bookings and
 * spend, and pay the monthly invoice. Bookers see their company and book "on account" at checkout.
 */
export default function Business() {
  const { data, loading, error, reload } = useLoad(() => api.get('/business/me'));
  if (loading) return <div className="container page"><Loading /></div>;
  if (error) return <div className="container page"><Alert tone="error">{error.message}</Alert></div>;
  return (
    <div className="container page">
      <div className="medium stack-lg">
        <PageHeader title="Company account" sub="One monthly invoice for your team's journeys, with cost-centre references on every receipt." />
        {!data.company && (!data.application || data.application.status === 'rejected') && <Apply onDone={reload} rejected={data.application} />}
        {!data.company && data.application?.status === 'pending' && (
          <Alert tone="info">Your application for <strong>{data.application.name}</strong> is with our team. We reply within 2 working days.</Alert>
        )}
        {data.company && <CompanyView me={data} reload={reload} />}
      </div>
    </div>
  );
}

function Apply({ onDone, rejected }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', companiesHouseNo: '', billingAddress: '', financeContact: '', financeEmail: '', expectedSpend: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    const errs = validate(f, {
      name: v.required('Company name'),
      companiesHouseNo: (x) => (/^([0-9]{8}|[A-Za-z]{2}[0-9]{6})$/.test(x.trim()) ? '' : 'Enter the 8-character Companies House number'),
      billingAddress: v.required('Billing address'),
      financeContact: v.required('Finance contact'),
      financeEmail: v.email,
    });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api.post('/business/apply', { ...f, expectedSpend: f.expectedSpend ? Number(f.expectedSpend) : undefined });
      toast('Application sent', 'success');
      onDone();
    } catch (x) {
      setErrors(x.fields || {});
      if (!x.fields) toast(x.message, 'error');
      setBusy(false);
    }
  };
  return (
    <section className="card stack">
      <h3>Register your company</h3>
      {rejected && <Alert tone="warn">Your last application ({rejected.name}) was not approved: {rejected.statusReason}</Alert>}
      <p className="small muted">We check the company number and reply within 2 working days. Once approved you become the account admin and can invite colleagues.</p>
      <form className="form-grid two" onSubmit={submit} noValidate>
        <TextField label="Company name" value={f.name} onChange={set('name')} error={errors.name} />
        <TextField label="Companies House number" value={f.companiesHouseNo} onChange={set('companiesHouseNo')} error={errors.companiesHouseNo} placeholder="01234567" />
        <TextField className="span-2" label="Billing address" value={f.billingAddress} onChange={set('billingAddress')} error={errors.billingAddress} />
        <TextField label="Finance contact" value={f.financeContact} onChange={set('financeContact')} error={errors.financeContact} />
        <TextField label="Finance email (for invoices)" type="email" value={f.financeEmail} onChange={set('financeEmail')} error={errors.financeEmail} />
        <TextField label="Expected monthly spend (GBP, optional)" type="number" value={f.expectedSpend} onChange={set('expectedSpend')} />
        <div className="span-2"><button className="btn" disabled={busy}>{busy ? 'Sending...' : 'Apply for a company account'}</button></div>
      </form>
    </section>
  );
}

function CompanyView({ me, reload }) {
  const toast = useToast();
  const c = me.company;
  const [tone, label] = STATUS[c.status] || ['', c.status];
  const admin = me.role === 'admin';
  const bookings = useLoad(() => (admin ? api.get('/business/bookings') : Promise.resolve(null)), [admin]);
  const [invite, setInvite] = useState('');
  const [inviteErr, setInviteErr] = useState('');
  const [paying, setPaying] = useState(null);
  const sendInvite = async (e) => {
    e.preventDefault();
    const m = v.email(invite);
    if (m) return setInviteErr(m);
    try {
      await api.post('/business/members/invite', { email: invite.trim() });
      toast(`Invitation sent to ${invite}`, 'success');
      setInvite('');
      reload();
    } catch (x) {
      setInviteErr(x.message);
    }
  };
  const remove = async (m) => {
    const r = await api.del(`/business/members/${m.id}`);
    toast(r.futureBookings.length ? `${m.name} removed. They have ${r.futureBookings.length} future company booking(s) for you to review.` : `${m.name} removed`, 'success');
    reload();
  };
  return (
    <>
      <section className="card stack">
        <div className="row-between"><h3>{c.name}</h3><span className={`badge ${tone}`}>{label}</span></div>
        {c.status === 'suspended' && <Alert tone="error">{c.statusReason}. Bookers can still travel but must pay by card until the invoice is paid.</Alert>}
        <Kv k="Your role" v={admin ? 'Account admin' : 'Booker'} />
        <Kv k="Spent this month" v={`${money(me.monthSpend)}${c.creditLimit ? ` of ${money(c.creditLimit)}` : ''}`} />
        <p className="small muted">To book on this account, choose <strong>Company account</strong> when you pay, and add a cost-centre reference if you like.</p>
        <div><Link to="/book" className="btn">Book a journey</Link></div>
      </section>
      {admin && (
        <>
          <section className="card stack">
            <h3>People who can book</h3>
            {me.members.map((m) => (
              <div key={m.id} className="row-between small">
                <span><strong>{m.name}</strong> {m.email} &middot; {m.role === 'admin' ? 'Admin' : 'Booker'}{!m.active && ' (removed)'}</span>
                {m.role === 'booker' && m.active && <button className="btn btn-ghost btn-sm" onClick={() => remove(m)}>Remove</button>}
              </div>
            ))}
            {me.invites.map((i) => <div key={i.email} className="small muted">Invited: {i.email} (until {fmtDate(i.expires_at)})</div>)}
            <form className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-end', gap: 8 }} onSubmit={sendInvite} noValidate>
              <div className="grow"><TextField label="Invite a colleague by email" type="email" value={invite} onChange={(e) => { setInvite(e.target.value); setInviteErr(''); }} error={inviteErr} /></div>
              <button className="btn btn-secondary">Invite</button>
            </form>
          </section>
          <section className="card stack">
            <h3>Invoices</h3>
            {me.invoices.length === 0 && <p className="small muted">No invoices yet. We invoice on the 1st of each month; invoices are due in 15 days.</p>}
            {me.invoices.map((i) => (
              <div key={i.id} className="row-between small">
                <span><span className="mono strong">{i.number}</span> &middot; issued {fmtDate(i.issuedAt)} &middot; due {fmtDate(i.dueOn)}</span>
                <span className="row" style={{ gap: 8 }}>
                  <strong>{money(i.total)}</strong>
                  <span className={`badge ${i.status === 'paid' ? 'green' : i.status === 'overdue' ? 'red' : 'amber'}`}>{i.status}</span>
                  {i.status !== 'paid' && <button className="btn btn-sm" onClick={() => setPaying(i)}>Pay</button>}
                </span>
              </div>
            ))}
          </section>
          <section className="card stack">
            <h3>Company journeys</h3>
            {bookings.loading && <Loading />}
            {bookings.data?.bookings.length === 0 && <Empty icon="calendar" title="No journeys yet" />}
            {bookings.data?.bookings.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>When</th><th>Booker</th><th>Journey</th><th>Cost centre</th><th>Amount</th><th>Invoice</th></tr></thead>
                  <tbody>
                    {bookings.data.bookings.map((b) => (
                      <tr key={b.ref}>
                        <td className="small">{fmtShort(b.pickupAt)}</td><td>{b.booker}</td><td className="small">{b.journey}<div className="tiny mono">{b.ref}</div></td>
                        <td className="mono small">{b.costCentre || '-'}</td><td>{money(b.total)}</td><td className="mono small">{b.invoice || 'Not billed yet'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {bookings.data && <p className="small">Total spend: <strong>{money(bookings.data.totalSpend)}</strong></p>}
          </section>
        </>
      )}
      {paying && <PayInvoice invoice={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); toast('Invoice paid - thank you', 'success'); reload(); }} />}
    </>
  );
}

function PayInvoice({ invoice, onClose, onDone }) {
  const [card, setCard] = useState(BLANK_CARD);
  const [errors, setErrors] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const pay = async (e) => {
    e.preventDefault();
    const errs = validateCardForm(card);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const { expMonth, expYear } = parseExpiry(card.expiry);
    setBusy(true);
    try {
      await api.post(`/business/invoices/${invoice.id}/pay`, { card: { number: onlyDigits(card.number), expMonth, expYear, cvv: card.cvv, holder: card.holder.trim() } });
      onDone();
    } catch (x) {
      setErr(x.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Pay ${invoice.number} - ${money(invoice.total)}`} onClose={onClose}>
      <form className="stack" onSubmit={pay} noValidate>
        {err && <Alert tone="error">{err}</Alert>}
        <CardForm value={card} onChange={setCard} errors={errors} />
        <button className="btn btn-lg btn-block" disabled={busy}>{busy ? 'Paying...' : `Pay ${money(invoice.total)}`}</button>
      </form>
    </Modal>
  );
}

/** N08: the link in the invitation email. */
export function JoinCompany() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [state, setState] = useState({ busy: true, error: '' });
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    api.post('/business/join', { token: params.get('token') || '' })
      .then(() => nav('/business', { replace: true }))
      .catch((e) => setState({ busy: false, error: e.message }));
  }, [params, nav]);
  return (
    <div className="container page">
      <div className="narrow card stack">
        <h2>Joining the company account</h2>
        {state.busy && <Loading />}
        {state.error && <Alert tone="error">{state.error}</Alert>}
      </div>
    </div>
  );
}
