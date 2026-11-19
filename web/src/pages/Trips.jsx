import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { PAYMENT_STATUS_LABEL, fmtDate, fmtDateTime, fmtTime, money } from '../format.js';
import { Alert, Empty, Kv, Loading, Modal, PageHeader, StatusBadge, TextArea, TextField, useLoad, useToast } from '../ui.jsx';
import { BookingCard, BookingExtras, PriceBreakdown, RouteLine } from '../components/BookingBits.jsx';
import Checkout from '../components/Checkout.jsx';
import { ReviewForm, ReviewSummary } from '../components/ReviewForm.jsx';

export function Trips() {
  const [when, setWhen] = useState('upcoming');
  const { data, loading, error } = useLoad(() => api.get(`/bookings?when=${when}`), [when]);
  return (
    <div className="container page">
      <div className="medium stack-lg">
        <PageHeader title="My trips" actions={<Link to="/book" className="btn"><Icon name="plus" size={18} /> New booking</Link>} />
        <div className="chips" role="tablist">
          {[['upcoming', 'Upcoming'], ['past', 'Past']].map(([k, l]) => (
            <button key={k} role="tab" aria-selected={when === k} className={`chip ${when === k ? 'active' : ''}`} onClick={() => setWhen(k)}>{l}</button>
          ))}
        </div>
        {loading && <Loading />}
        {error && <Alert tone="error">{error.message}</Alert>}
        {data && data.bookings.length === 0 && (
          <Empty icon="calendar" title={when === 'upcoming' ? 'No upcoming trips' : 'No past trips yet'}
            action={<Link to="/book" className="btn">Book a minicab</Link>}>
            {when === 'upcoming' ? 'Book online and save 15%.' : 'Completed and cancelled journeys appear here.'}
          </Empty>
        )}
        <div className="stack">{data?.bookings.map((b) => <BookingCard key={b.id} b={b} />)}</div>
      </div>
    </div>
  );
}

// Report Figure 25: the normal path of a booking.
const STAGES = [
  ['confirmed', 'Booking confirmed'],
  ['assigned', 'Driver assigned'],
  ['on_route', 'Driver on the way'],
  ['arrived', 'Driver has arrived'],
  ['in_progress', 'On the journey'],
  ['completed', 'Journey completed'],
];
const ENDED = ['cancelled', 'company_cancelled', 'no_show', 'abandoned'];

/** N25: book the same journey again (new date and time). */
export function rebookLink(b) {
  const q = new URLSearchParams({ service: b.service.code, pickup: b.pickup, passengers: String(b.passengers), size: b.size.code });
  if (b.service.code !== 'daily_hire') q.set('destination', b.destination);
  return `/book?${q}`;
}

function Timeline({ status }) {
  const idx = Math.max(0, STAGES.findIndex(([k]) => k === status));
  return (
    <div className="timeline">
      {STAGES.map(([k, label], i) => (
        <div key={k} className={`tl ${i < idx ? 'done' : i === idx ? 'cur done' : ''}`}>
          <span className="dot" />
          <span className={i <= idx ? 'strong' : 'muted'}>{label}</span>
        </div>
      ))}
    </div>
  );
}

function CancelModal({ b, payments, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const net = payments.reduce((a, p) => a + (p.kind === 'charge' ? p.amount : -p.amount), 0);
  const last = payments.find((p) => p.kind === 'charge');
  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.post(`/bookings/${b.id}/cancel`, { reason });
      onDone(r);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Cancel this booking?"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-subtle" onClick={onClose} disabled={busy}>Keep my booking</button>
          <button className="btn btn-danger" onClick={go} disabled={busy}>{busy ? 'Cancelling...' : 'Yes, cancel booking'}</button>
        </>
      }
    >
      {err && <Alert tone="error">{err}</Alert>}
      <p>
        <strong>{fmtDateTime(b.pickupAt)}</strong><br />
        {b.pickup} to {b.destination}
      </p>
      {net > 0 ? (
        <Alert tone="info" icon="card">
          You will be refunded <strong>{money(net)}</strong>{last ? ` to ${last.method === 'card' ? `${last.cardBrandLabel} ending ${last.cardLast4}` : last.method}` : ''}.
        </Alert>
      ) : (
        <p className="muted small">Nothing has been paid for this booking, so there is nothing to refund.</p>
      )}
      <TextArea label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} style={{ minHeight: 80 }} />
    </Modal>
  );
}

export function TripDetail() {
  const { id } = useParams();
  const loc = useLocation();
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  const { data, loading, error, reload } = useLoad(() => api.get(`/bookings/${id}`), [id]);
  if (loading) return <div className="container page"><Loading /></div>;
  if (error) return <div className="container page"><div className="medium"><Alert tone="error">{error.message}</Alert><p style={{ marginTop: 16 }}><Link to="/trips" className="btn btn-subtle">Back to my trips</Link></p></div></div>;
  const b = data.booking;
  const cancelled = ENDED.includes(b.status);
  const pending = b.status === 'pending_payment';
  return (
    <div className="container page">
      <div className="medium stack-lg">
        <div><Link to="/trips" className="small strong">&larr; My trips</Link></div>
        {loc.state?.justBooked && (
          <Alert tone="success">
            <strong>You are booked.</strong> Your reference is <span className="mono strong">{b.ref}</span>. We have emailed the details - see{' '}
            <Link to="/messages" className="strong">Messages</Link>.
          </Alert>
        )}
        {pending && (
          <Alert tone="warn" icon="clock">
            <div className="row-between" style={{ gap: 12, flexWrap: 'wrap' }}>
              <span>This booking is waiting for payment. We hold the cab until {fmtTime(b.holdExpiresAt)}.</span>
              <Link to={`/trips/${b.id}/pay`} className="btn btn-sm">Complete payment</Link>
            </div>
          </Alert>
        )}
        {b.status === 'interrupted' && (
          <Alert tone="error" icon="alert">Your journey was interrupted. We are sending a replacement car and will text you its details. Your fare will not go up.</Alert>
        )}
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div>
            <h2>{fmtDate(b.pickupAt)}</h2>
            <p className="muted" style={{ marginTop: 4 }}>{fmtTime(b.pickupAt)} &middot; {b.service.label}</p>
          </div>
          <div className="stack-sm" style={{ alignItems: 'flex-end' }}>
            <StatusBadge status={b.status} />
            <span className="mono small muted">{b.ref}</span>
          </div>
        </div>

        {!cancelled && !pending && b.status !== 'interrupted' && (
          <section className="card stack">
            <h3>Progress</h3>
            <Timeline status={b.status} />
          </section>
        )}

        {b.vehicle && !cancelled && (
          <section className="card card-dark stack">
            <h3>Your car</h3>
            <div className="row" style={{ gap: 24 }}>
              <div><div className="tiny" style={{ color: '#c9c9c9' }}>Registration</div><div className="mono strong" style={{ fontSize: 24 }}>{b.vehicle.reg}</div></div>
              <div><div className="tiny" style={{ color: '#c9c9c9' }}>Car</div><div className="strong">{b.vehicle.colour} {b.vehicle.make} {b.vehicle.model}</div></div>
              {b.driver && (
                <div className="row" style={{ gap: 12 }}>
                  {b.driver.photoUrl ? (
                    <img src={b.driver.photoUrl} alt={`Driver ${b.driver.name}`} width="48" height="48" style={{ borderRadius: 999, objectFit: 'cover' }} />
                  ) : (
                    <span className="avatar" aria-hidden="true">{b.driver.name[0]}</span>
                  )}
                  <div>
                    <div className="tiny" style={{ color: '#c9c9c9' }}>Driver</div>
                    <div className="strong">{b.driver.name}</div>
                    {b.driver.licenceNo && <div className="tiny" style={{ color: '#c9c9c9' }}>Licence {b.driver.licenceNo}</div>}
                  </div>
                </div>
              )}
              {b.etaMinutes != null && b.status === 'on_route' && <div><div className="tiny" style={{ color: '#c9c9c9' }}>Arriving in</div><div className="strong">about {b.etaMinutes} min</div></div>}
            </div>
            <p className="small muted">Check the registration matches before you get in.</p>
          </section>
        )}

        <section className="card stack">
          <h3>Journey</h3>
          <RouteLine pickup={b.pickup} destination={b.destination} />
          <hr className="sep" />
          <Kv k="Date and time" v={fmtDateTime(b.pickupAt)} />
          <Kv k="Passengers" v={b.passengers} />
          <Kv k="Cab size" v={b.size.label} />
          {b.package ? <Kv k="Package" v={b.package.label} /> : b.hours && <Kv k="Hire length" v={`${b.hours} hours`} />}
          <BookingExtras b={b} />
          {data.linked?.map((l) => (
            <p key={l.id} className="small">
              <Icon name="route" size={14} /> {l.isReturn ? 'Return journey' : 'Outward journey'}{' '}
              <Link to={`/trips/${l.id}`} className="strong">{l.ref}</Link> on {fmtDateTime(l.pickupAt)}
            </p>
          ))}
          <Kv k="Updates by" v={{ email: 'Email', text: `Text (${b.notifyPhone || ''})`, both: `Email and text (${b.notifyPhone || ''})` }[b.notifyPref]} />
        </section>

        <section className="card stack">
          <h3>Price and payment</h3>
          <PriceBreakdown price={b.price} />
          {data.payments.map((p) => (
            <div key={p.id} className="small muted">
              {p.kind === 'refund' ? 'Refunded' : 'Paid'} {money(p.amount)} by {p.method === 'card' ? `${p.cardBrandLabel} ending ${p.cardLast4}` : p.method === 'paypal' ? 'PayPal' : p.method === 'bank' ? `bank transfer${p.bankName ? ` (${p.bankName})` : ''}` : 'cash'} on {fmtDate(p.createdAt)}
            </div>
          ))}
          {b.paymentStatus && b.paymentStatus !== 'paid' && <p className="small"><span className="badge">{PAYMENT_STATUS_LABEL[b.paymentStatus] || b.paymentStatus}</span></p>}
          {data.payments.length > 0 && (
            <div><Link to={`/trips/${b.id}/receipt`} className="btn btn-secondary btn-sm"><Icon name="file" size={16} /> View and print receipt</Link></div>
          )}
          {b.priority && <p className="small muted"><Icon name="zap" size={14} /> Priority service: online bookings are dispatched first.</p>}
        </section>

        {['confirmed', 'assigned', 'on_route', 'arrived', 'in_progress', 'interrupted'].includes(b.status) && (
          <JourneyHelp b={b} />
        )}
        <div className="row small" style={{ gap: 16 }}>
          <Link to={`/contact?booking=${b.id}`} className="strong"><Icon name="message" size={14} /> Ask us about this trip</Link>
          {['completed', 'no_show', 'in_progress', 'interrupted'].includes(b.status) && (
            <Link to={`/support?booking=${b.id}`} className="strong"><Icon name="alert" size={14} /> Lost item or complaint</Link>
          )}
          {['completed', 'cancelled', 'company_cancelled', 'no_show'].includes(b.status) && (
            <Link to={rebookLink(b)} className="strong"><Icon name="route" size={14} /> Book this journey again</Link>
          )}
        </div>
        {b.status === 'completed' && (
          <section className="card stack">
            <h3>{data.review ? 'Your review' : 'How was your journey?'}</h3>
            {data.review ? <ReviewSummary review={data.review} /> : <ReviewForm bookingId={b.id} onDone={() => { toast('Thank you for your review', 'success'); reload(); }} />}
          </section>
        )}
        {cancelled && (
          <Alert tone="warn" icon="alert">
            {b.status === 'abandoned' ? 'This booking was not paid, so the cab was released.' : b.status === 'no_show' ? 'This booking was recorded as a no-show.' : `This booking was cancelled${b.cancelledAt ? ` on ${fmtDate(b.cancelledAt)}` : ''}${b.status === 'company_cancelled' ? ' by us. We are sorry.' : '.'}`}{' '}
            {data.payments.some((p) => p.kind === 'refund') ? 'Your refund has been issued.' : ''}
          </Alert>
        )}
        {!cancelled && !pending && ['confirmed', 'assigned'].includes(b.status) && (
          <section className="card stack">
            <h3>Change or cancel</h3>
            {b.modifiable ? (
              <>
                <p className="small muted">Free of charge until {fmtDateTime(b.cancelDeadline)} (24 hours before pickup).</p>
                <div className="row">
                  <Link to={`/trips/${b.id}/amend`} className="btn btn-secondary"><Icon name="edit" size={18} /> Change booking</Link>
                  <button className="btn btn-subtle" onClick={() => setCancelling(true)}><Icon name="x" size={18} /> Cancel booking</button>
                </div>
              </>
            ) : (
              <>
                <p className="small muted">
                  Changes and cancellations closed {fmtDateTime(b.cancelDeadline)}, 24 hours before pickup. Please call us on 020 7000 0000.
                </p>
                <div className="row">
                  <button className="btn btn-secondary" disabled><Icon name="edit" size={18} /> Change booking</button>
                  <button className="btn btn-subtle" disabled><Icon name="x" size={18} /> Cancel booking</button>
                </div>
              </>
            )}
          </section>
        )}
        {cancelling && (
          <CancelModal b={b} payments={data.payments} onClose={() => setCancelling(false)} onDone={(r) => {
            setCancelling(false);
            toast(r.refund ? `Booking cancelled. ${money(r.refund.amount)} refunded.` : 'Booking cancelled.', 'success');
            reload();
          }} />
        )}
      </div>
    </div>
  );
}

/** ID-54: finish paying for a booking that is waiting for payment (retry, or back from PayPal / the bank). */
export function PayPending() {
  const { id } = useParams();
  const loc = useLocation();
  const nav = useNavigate();
  const [redirectResult] = useState(() => loc.state?.redirect || null);
  const { data, loading, error } = useLoad(() => api.get(`/bookings/${id}`), [id]);
  if (loading) return <div className="container page"><Loading /></div>;
  if (error) return <div className="container page"><Alert tone="error">{error.message}</Alert></div>;
  const b = data.booking;
  const done = (r) => nav(`/trips/${r.booking.id}`, { replace: true, state: { justBooked: true } });
  const total = b.price.total + (data.linked || []).filter((l) => l.status === 'pending_payment').reduce((a, l) => a + l.total, 0);
  return (
    <div className="container page">
      <div className="medium stack-lg">
        <div><Link to={`/trips/${b.id}`} className="small strong">&larr; Back to the booking</Link></div>
        <PageHeader title="Complete payment" sub={`${b.ref} - ${fmtDateTime(b.pickupAt)}`} />
        {b.status !== 'pending_payment' && !redirectResult ? (
          <Alert tone="info">This booking is not waiting for payment. <Link to={`/trips/${b.id}`} className="strong">View it</Link></Alert>
        ) : (
          <>
            <section className="card stack">
              <RouteLine pickup={b.pickup} destination={b.destination} />
              <PriceBreakdown price={b.price} />
            </section>
            <Checkout amount={total} pendingId={b.id} holdUntil={b.holdExpiresAt} onDone={done} returnTo={`/trips/${b.id}/pay`} redirectResult={redirectResult} create={() => Promise.reject(new Error('unused'))} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * During a journey (N20 contact us, N21 share my trip, N22 emergency button).
 * A person is always reachable by phone while a journey is running (TfL rule in the report).
 */
function JourneyHelp({ b }) {
  const toast = useToast();
  const [share, setShare] = useState(null);
  const [contact, setContact] = useState('');
  const [modal, setModal] = useState(null); // 'emergency' | 'problem'
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const live = ['on_route', 'arrived', 'in_progress', 'interrupted'].includes(b.status);

  const doShare = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/bookings/${b.id}/share`, contact.trim() ? { contact: contact.trim() } : {});
      setShare(r);
      try {
        await navigator.clipboard.writeText(r.url);
        toast('Link copied', 'success');
      } catch {
        /* clipboard not available */
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const stopShare = async () => {
    await api.del(`/bookings/${b.id}/share`);
    setShare(null);
    toast('Sharing turned off', 'success');
  };
  const report = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/bookings/${b.id}/incident`, { kind: modal, message: msg.trim() || undefined });
      setDone(r.message);
      setModal(null);
      setMsg('');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack">
      <h3>{live ? 'Your journey' : 'Before you travel'}</h3>
      {done && <Alert tone="success">{done}</Alert>}
      <div className="row" style={{ gap: 8 }}>
        <a className="btn btn-secondary btn-sm" href="tel:02070000000"><Icon name="phone" size={16} /> Call us 020 7000 0000</a>
        {live && <button className="btn btn-subtle btn-sm" onClick={() => setModal('problem')}><Icon name="alert" size={16} /> Problem with my journey</button>}
        {live && <button className="btn btn-sm" style={{ background: '#c13515' }} onClick={() => setModal('emergency')}><Icon name="alert" size={16} /> Emergency</button>}
      </div>
      <div className="stack-sm">
        <div className="label">Share my trip</div>
        {share ? (
          <div className="stack-sm">
            <div className="small">Anyone with this link can follow the car until 2 hours after the journey:</div>
            <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <input className="input mono small" readOnly value={share.url} aria-label="Share link" onFocus={(e) => e.target.select()} />
              <button className="btn btn-ghost btn-sm" onClick={stopShare}>Stop sharing</button>
            </div>
          </div>
        ) : (
          <div className="row" style={{ gap: 8, flexWrap: 'nowrap', alignItems: 'flex-end' }}>
            <div className="grow">
              <TextField label="Send the link to (optional)" placeholder="Email or mobile number" value={contact} onChange={(e) => setContact(e.target.value)} />
            </div>
            <button className="btn btn-secondary" onClick={doShare} disabled={busy}>Share</button>
          </div>
        )}
      </div>
      {modal && (
        <Modal title={modal === 'emergency' ? 'Emergency' : 'Problem with my journey'} onClose={() => setModal(null)}>
          <div className="stack">
            {modal === 'emergency' ? (
              <Alert tone="error" icon="alert">
                <strong>If anyone is in danger, call 999 now.</strong> Pressing the button below also alerts our control room, who will call you.
              </Alert>
            ) : (
              <p className="small muted">Tell us what is wrong (wrong car, driver late, breakdown, change of destination). Our control room will call you.</p>
            )}
            {modal === 'emergency' && <a className="btn btn-lg btn-block" style={{ background: '#c13515' }} href="tel:999">Call 999</a>}
            <TextArea label="What is happening? (optional)" rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} />
            <button className="btn btn-lg btn-block" onClick={report} disabled={busy}>{busy ? 'Sending...' : 'Alert the control room'}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
