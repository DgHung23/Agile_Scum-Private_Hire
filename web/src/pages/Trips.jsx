import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { fmtDate, fmtDateTime, fmtTime, money } from '../format.js';
import { Alert, Empty, Kv, Loading, Modal, PageHeader, StatusBadge, TextArea, useLoad, useToast } from '../ui.jsx';
import { BookingCard, PriceBreakdown, RouteLine } from '../components/BookingBits.jsx';

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

const STAGES = [
  ['confirmed', 'Booking confirmed'],
  ['assigned', 'Driver assigned'],
  ['on_route', 'Driver on the way'],
  ['completed', 'Journey completed'],
];

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
  const cancelled = b.status === 'cancelled';
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

        {!cancelled && (
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
              {b.driver && <div><div className="tiny" style={{ color: '#c9c9c9' }}>Driver</div><div className="strong">{b.driver.name}</div></div>}
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
          {b.hours && <Kv k="Hire length" v={`${b.hours} hours`} />}
          <Kv k="Updates by" v={{ email: 'Email', text: `Text (${b.notifyPhone || ''})`, both: `Email and text (${b.notifyPhone || ''})` }[b.notifyPref]} />
        </section>

        <section className="card stack">
          <h3>Price and payment</h3>
          <PriceBreakdown price={b.price} />
          {data.payments.map((p) => (
            <div key={p.id} className="small muted">
              {p.kind === 'refund' ? 'Refunded' : 'Paid'} {money(p.amount)} by {p.method === 'card' ? `${p.cardBrandLabel} ending ${p.cardLast4}` : p.method === 'paypal' ? 'PayPal' : 'cash'} on {fmtDate(p.createdAt)}
            </div>
          ))}
          {data.payments.length > 0 && (
            <div><Link to={`/trips/${b.id}/receipt`} className="btn btn-secondary btn-sm"><Icon name="file" size={16} /> View and print receipt</Link></div>
          )}
          {b.priority && <p className="small muted"><Icon name="zap" size={14} /> Priority service: online bookings are dispatched first.</p>}
        </section>

        {cancelled && (
          <Alert tone="warn" icon="alert">This booking was cancelled{b.cancelledAt ? ` on ${fmtDate(b.cancelledAt)}` : ''}. {data.payments.some((p) => p.kind === 'refund') ? 'Your refund has been issued.' : ''}</Alert>
        )}
        {!cancelled && b.status !== 'completed' && (
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
