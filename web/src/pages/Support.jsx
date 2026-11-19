import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { fmtDate, fmtShort } from '../format.js';
import { Alert, Empty, Loading, PageHeader, SelectField, TextArea, TextField, useLoad, useToast } from '../ui.jsx';
import { v } from '../validators.js';

const FAQ = [
  ['How far ahead can I book?', 'From 30 minutes to 90 days ahead. We are a pre-booked service, so "as soon as possible" means about 30 minutes from now.'],
  ['Why is booking online cheaper?', 'Every online booking is 15% cheaper than booking by phone or in person. You can also use one coupon per booking.'],
  ['Can I see a price without an account?', 'Yes. Start a booking and you will see the price for every cab size before you sign in.'],
  ['How do I cancel or change a booking?', 'From My trips, free of charge until 24 hours before pickup. After that, call us on 020 7000 0000. If your driver is more than 15 minutes late you can cancel free of charge.'],
  ['When do I get my refund?', 'Refunds go back to the way you paid and usually take 3 to 5 working days. A credit note appears in Receipts.'],
  ['Do you charge for wheelchairs or assistance dogs?', 'Never. Choose the accessibility options when you book and we send a suitable car at no extra cost.'],
  ['My flight is late. Will I pay waiting time?', 'No. Add your flight number and we follow the landing time.'],
  ['How long will the driver wait?', 'Ten minutes free from the time the driver arrives. After that the booking may be recorded as a no-show.'],
  ['How do I get a receipt for my company?', 'Open Receipts, then Save as PDF or Send it to another address such as your accounts team. Receipts show VAT.'],
];

/** N14 Help and FAQ, with the "Lost something?" form for people without an account (report Appendix G.1). */
export function Help() {
  const { user } = useAuth();
  return (
    <div className="container page">
      <div className="medium stack-lg">
        <PageHeader title="Help and FAQ" sub="Quick answers. You can always call us on 020 7000 0000, day and night." />
        <section className="stack-sm">
          {FAQ.map(([q, a]) => (
            <details key={q} className="card">
              <summary className="strong" style={{ cursor: 'pointer' }}>{q}</summary>
              <p className="small muted" style={{ marginTop: 10 }}>{a}</p>
            </details>
          ))}
        </section>
        <section className="card stack">
          <h3>Still need help?</h3>
          <div className="row">
            <Link to="/contact" className="btn btn-secondary">Send us an enquiry</Link>
            <a href="tel:02070000000" className="btn btn-subtle">Call 020 7000 0000</a>
            {user?.role === 'customer' && <Link to="/support" className="btn btn-subtle">Lost items and complaints</Link>}
          </div>
        </section>
        {user?.role !== 'customer' && <LostVisitorForm />}
      </div>
    </div>
  );
}

function LostVisitorForm() {
  const [f, setF] = useState({ bookingRef: '', email: '', description: '', colour: '' });
  const [errors, setErrors] = useState({});
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const x = {};
    if (!f.bookingRef.trim()) x.bookingRef = 'Enter the booking reference';
    const em = v.email(f.email);
    if (em) x.email = em;
    if (f.description.trim().length < 3) x.description = 'Describe the item';
    setErrors(x);
    if (Object.keys(x).length) return;
    setBusy(true);
    try {
      await api.post('/support/lost-items', f);
      setDone('Thank you. We have logged your item and will email you at each step.');
    } catch (err) {
      setErrors(err.fields || {});
      if (!err.fields) setDone('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack" id="lost">
      <h3>Lost something?</h3>
      <p className="small muted">Give the booking reference and the email on the booking. Signed-in customers can report from My trips.</p>
      {done ? <Alert tone="success">{done}</Alert> : (
        <form className="form-grid two" onSubmit={submit} noValidate>
          <TextField label="Booking reference" placeholder="PH-..." value={f.bookingRef} onChange={(e) => setF({ ...f, bookingRef: e.target.value.toUpperCase() })} error={errors.bookingRef} />
          <TextField label="Email on the booking" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={errors.email} />
          <TextArea className="span-2" label="What did you lose?" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} error={errors.description} />
          <TextField label="Colour (optional)" value={f.colour} onChange={(e) => setF({ ...f, colour: e.target.value })} />
          <div><button className="btn" disabled={busy}>{busy ? 'Sending...' : 'Report lost item'}</button></div>
        </form>
      )}
    </section>
  );
}

const CATEGORIES = [['driver', 'The driver'], ['vehicle', 'The car'], ['route', 'The route'], ['price', 'The price'], ['accessibility', 'Accessibility'], ['safety', 'Safety'], ['other', 'Something else']];

/** N23 report a lost item and N24 make a complaint (answered within 5 working days). */
export default function Support() {
  const toast = useToast();
  const [params] = useSearchParams();
  const trips = useLoad(() => api.get('/bookings?when=all'));
  const lost = useLoad(() => api.get('/support/lost-items'));
  const complaints = useLoad(() => api.get('/support/complaints'));
  const [li, setLi] = useState({ bookingId: params.get('booking') || '', description: '', colour: '', contactPref: 'email' });
  const [cp, setCp] = useState({ bookingId: params.get('booking') || '', category: 'driver', text: '' });
  const [errs, setErrs] = useState({});
  const journeys = (trips.data?.bookings || []).filter((b) => !['pending_payment', 'abandoned'].includes(b.status));
  const send = async (path, body, reset, reload, msg) => {
    setErrs({});
    try {
      await api.post(path, body);
      toast(msg, 'success');
      reset();
      reload();
    } catch (e) {
      setErrs(e.fields || {});
      if (!e.fields) toast(e.message, 'error');
    }
  };
  const tripOptions = journeys.map((b) => <option key={b.id} value={b.id}>{fmtDate(b.pickupAt)} - {b.pickup} to {b.destination} ({b.ref})</option>);
  return (
    <div className="container page">
      <div className="medium stack-lg">
        <PageHeader title="Lost items and complaints" sub="Tell us what went wrong. A person reads every message." />
        <section className="card stack">
          <h3>Report a lost item</h3>
          <form className="form-grid two" onSubmit={(e) => { e.preventDefault(); send('/support/lost-items', li, () => setLi({ ...li, description: '', colour: '' }), lost.reload, 'Logged - we will keep you updated'); }} noValidate>
            <SelectField className="span-2" label="Which journey?" value={li.bookingId} onChange={(e) => setLi({ ...li, bookingId: e.target.value })} error={errs.bookingRef}>
              <option value="">Choose a journey</option>
              {tripOptions}
            </SelectField>
            <TextArea className="span-2" label="What did you lose?" rows={2} value={li.description} onChange={(e) => setLi({ ...li, description: e.target.value })} error={errs.description} />
            <TextField label="Colour (optional)" value={li.colour} onChange={(e) => setLi({ ...li, colour: e.target.value })} />
            <SelectField label="Update me by" value={li.contactPref} onChange={(e) => setLi({ ...li, contactPref: e.target.value })}>
              <option value="email">Email</option><option value="text">Text</option><option value="phone">Phone call</option>
            </SelectField>
            <div><button className="btn" disabled={!li.bookingId}>Report lost item</button></div>
          </form>
          {lost.loading && <Loading />}
          {lost.data?.items.map((i) => (
            <div key={i.id} className="row-between small">
              <span>{i.description} <span className="muted mono">{i.ref}</span></span>
              <span className={`badge ${['found', 'ready', 'sent', 'returned'].includes(i.status) ? 'green' : i.status === 'not_found' ? 'red' : 'amber'}`}>{i.statusLabel}</span>
            </div>
          ))}
        </section>
        <section className="card stack">
          <h3>Make a complaint</h3>
          <p className="small muted">We answer every complaint within 5 working days.</p>
          <form className="form-grid two" onSubmit={(e) => { e.preventDefault(); send('/support/complaints', { ...cp, bookingId: cp.bookingId || undefined }, () => setCp({ ...cp, text: '' }), complaints.reload, 'Complaint received'); }} noValidate>
            <SelectField label="Journey (optional)" value={cp.bookingId} onChange={(e) => setCp({ ...cp, bookingId: e.target.value })}>
              <option value="">Not about one journey</option>
              {tripOptions}
            </SelectField>
            <SelectField label="It is about" value={cp.category} onChange={(e) => setCp({ ...cp, category: e.target.value })}>
              {CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </SelectField>
            <TextArea className="span-2" label="What happened?" rows={4} value={cp.text} onChange={(e) => setCp({ ...cp, text: e.target.value })} error={errs.text} />
            <div><button className="btn">Send complaint</button></div>
          </form>
          {complaints.data?.complaints.length === 0 && <Empty icon="message" title="No complaints" />}
          {complaints.data?.complaints.map((c) => (
            <div key={c.id} className="stack-sm" style={{ borderTop: '1px solid var(--hair-soft, #eee)', paddingTop: 10 }}>
              <div className="row-between small">
                <span className="strong">{CATEGORIES.find((x) => x[0] === c.category)?.[1]}{c.ref ? ` - ${c.ref}` : ''}</span>
                <span className={`badge ${c.status === 'open' ? 'amber' : 'green'}`}>{c.status === 'open' ? `Answer by ${fmtDate(c.dueBy)}` : 'Answered'}</span>
              </div>
              <p className="small muted">{c.text}</p>
              {c.answer && <Alert tone="info">{c.answer} <span className="tiny">({fmtShort(c.answeredAt)})</span></Alert>}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
