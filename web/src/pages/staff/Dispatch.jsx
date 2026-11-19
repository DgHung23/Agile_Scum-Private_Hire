import { Link } from 'react-router-dom';
import { useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { fmtDateTime, fmtTime } from '../../format.js';
import { Alert, Empty, Loading, Modal, PageHeader, SelectField, StatusBadge, TextField, useLoad, useToast } from '../../ui.jsx';

function AssignModal({ b, onClose, onDone }) {
  const opts = useLoad(() => api.get(`/staff/bookings/${b.id}/options`));
  const [driverId, setDriverId] = useState('');
  const [cabId, setCabId] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!driverId) return setErr('Choose a driver');
    setBusy(true);
    setErr('');
    try {
      await api.post(`/staff/bookings/${b.id}/assign`, { driverId, ...(cabId ? { cabId } : {}) });
      onDone();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Assign driver - ${b.ref}`} onClose={onClose}
      footer={<><button className="btn btn-subtle" onClick={onClose} disabled={busy}>Cancel</button><button className="btn" onClick={go} disabled={busy}>{busy ? 'Assigning...' : 'Assign'}</button></>}>
      <p className="small muted">{fmtDateTime(b.pickupAt)} &middot; {b.pickup} to {b.destination} &middot; {b.passengers} passengers</p>
      {err && <Alert tone="error">{err}</Alert>}
      {opts.loading && <Loading />}
      {opts.data && (
        <>
          <SelectField label={`Free drivers (${opts.data.drivers.length})`} value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">Choose a driver...</option>
            {opts.data.drivers.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
          </SelectField>
          <SelectField label="Cab" value={cabId} onChange={(e) => setCabId(e.target.value)} hint="Leave as booked unless the cab has to change">
            <option value="">Keep the booked cab ({b.vehicle?.reg})</option>
            {opts.data.cabs.filter((c) => !c.current).map((c) => <option key={c.id} value={c.id}>{c.reg} - {c.colour} {c.make} {c.model} ({c.sizeLabel})</option>)}
          </SelectField>
        </>
      )}
    </Modal>
  );
}

function RouteModal({ b, onClose, onDone }) {
  const [eta, setEta] = useState(b.etaMinutes || 12);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.post(`/staff/bookings/${b.id}/status`, { status: 'on_route', etaMinutes: Number(eta) });
      const sms = r.sent.find((s) => s.channel === 'sms');
      toast(sms ? 'Text sent to the customer with the car details' : r.sent.length ? 'Customer emailed' : 'ETA updated (text goes out at 15 minutes or less)', 'success');
      onDone();
    } catch (e) {
      setErr(e.fields?.etaMinutes || e.message);
      setBusy(false);
    }
  };
  const wantsText = ['text', 'both'].includes(b.notifyPref);
  return (
    <Modal title={b.status === 'on_route' ? 'Update ETA' : 'Driver on route'} onClose={onClose}
      footer={<><button className="btn btn-subtle" onClick={onClose} disabled={busy}>Cancel</button><button className="btn" onClick={go} disabled={busy}>{busy ? 'Saving...' : b.status === 'on_route' ? 'Update' : 'Set on route'}</button></>}>
      {err && <Alert tone="error">{err}</Alert>}
      <TextField label="Minutes until the driver arrives (ETA)" type="number" min="1" max="120" value={eta} onChange={(e) => setEta(e.target.value)} />
      {wantsText ? (
        <Alert tone="info" icon="phone">
          The customer chose text updates. When the ETA is <strong>15 minutes or less</strong> we text <strong>{b.notifyPhone}</strong> the car's registration, colour and make - once.
          {b.arrivalSmsSent && ' (Already sent.)'}
        </Alert>
      ) : (
        <p className="small muted">The customer chose {b.notifyPref === 'email' ? 'email' : 'email and text'} updates.</p>
      )}
    </Modal>
  );
}

function Card({ b, actions }) {
  return (
    <article className="card stack-sm">
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="strong">{fmtTime(b.pickupAt)} <span className="muted small">{new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' }).format(new Date(b.pickupAt))}</span></div>
          <div className="small muted">{b.service.label} &middot; {b.passengers} pax &middot; {b.size.label}</div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {b.priority && <span className="badge black"><Icon name="zap" size={12} /> Priority</span>}
          <StatusBadge status={b.status} />
        </div>
      </div>
      <div className="small">{b.pickup} &rarr; {b.destination}</div>
      <div className="tiny mono">{b.ref} &middot; {b.customer.name} &middot; {b.customer.phone}</div>
      {b.vehicle && <div className="small"><Icon name="car" size={14} /> <span className="mono strong">{b.vehicle.reg}</span> {b.vehicle.colour} {b.vehicle.make}{b.driver ? ` · ${b.driver.name} (${b.driver.phone})` : ''}</div>}
      {b.status === 'on_route' && <div className="small strong"><Icon name="clock" size={14} /> ETA {b.etaMinutes} min</div>}
      {(b.accessibility?.length > 0 || b.childSeatAges?.length > 0) && <div className="tiny">Needs: {[...(b.accessibility || []).map((a) => a.replace(/_/g, ' ')), ...(b.childSeatAges?.length ? [`${b.childSeatAges.length} child seat(s)`] : [])].join(', ')}</div>}
      <div className="row">{actions}<Link to={`/staff/bookings/${b.id}`} className="btn btn-ghost btn-sm">Manage</Link></div>
    </article>
  );
}

/** US9.9: dispatch board. Online (priority) bookings are listed first. */
export default function Dispatch() {
  const toast = useToast();
  const { data, loading, error, reload } = useLoad(() => api.get('/staff/dispatch'));
  const [assign, setAssign] = useState(null);
  const [route, setRoute] = useState(null);

  const act = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast(msg, 'success');
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="stack-lg">
      <PageHeader title="Dispatch" sub="Assign drivers, send them on route and complete journeys. Priority online bookings come first."
        actions={<button className="btn btn-subtle" onClick={reload}>Refresh</button>} />
      {loading && !data && <Loading />}
      {error && <Alert tone="error">{error.message}</Alert>}
      {data && (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', alignItems: 'start' }}>
          <section className="stack">
            <h3>Needs a driver ({data.needsDriver.length})</h3>
            {data.needsDriver.length === 0 && <Empty icon="check" title="All covered" />}
            {data.needsDriver.map((b) => <Card key={b.id} b={b} actions={<button className="btn btn-sm" onClick={() => setAssign(b)}>Assign driver</button>} />)}
          </section>
          <section className="stack">
            <h3>Assigned ({data.assigned.length})</h3>
            {data.assigned.length === 0 && <Empty icon="wheel" title="Nobody assigned" />}
            {data.assigned.map((b) => (
              <Card key={b.id} b={b} actions={
                <>
                  <button className="btn btn-sm" onClick={() => setRoute(b)}>Set on route</button>
                  <button className="btn btn-subtle btn-sm" onClick={() => setAssign(b)}>Change</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.post(`/staff/bookings/${b.id}/unassign`), 'Driver removed')}>Unassign</button>
                </>
              } />
            ))}
          </section>
          <section className="stack">
            <h3>On the road ({data.onRoute.length})</h3>
            {data.onRoute.length === 0 && <Empty icon="map" title="No cars on the road" />}
            {data.onRoute.map((b) => (
              <Card key={b.id} b={b} actions={
                <>
                  {b.status === 'on_route' && <button className="btn btn-sm" onClick={() => act(() => api.post(`/staff/bookings/${b.id}/status`, { status: 'arrived' }), 'Arrived - customer told')}>Arrived</button>}
                  {b.status === 'arrived' && <button className="btn btn-sm" onClick={() => act(() => api.post(`/staff/bookings/${b.id}/status`, { status: 'in_progress' }), 'Picked up')}>Picked up</button>}
                  {b.status === 'in_progress' && b.paymentStatus !== 'due_cash' && <button className="btn btn-sm" onClick={() => act(() => api.post(`/staff/bookings/${b.id}/status`, { status: 'completed' }), 'Journey completed - review invitation emailed')}>Complete journey</button>}
                  {b.status === 'on_route' && <button className="btn btn-subtle btn-sm" onClick={() => setRoute(b)}>Update ETA</button>}
                </>
              } />
            ))}
          </section>
          {data.interrupted?.length > 0 && (
            <section className="stack">
              <h3>Interrupted ({data.interrupted.length})</h3>
              {data.interrupted.map((b) => <Card key={b.id} b={b} actions={<Link to={`/staff/bookings/${b.id}`} className="btn btn-sm">Send replacement</Link>} />)}
            </section>
          )}
        </div>
      )}
      {assign && <AssignModal b={assign} onClose={() => setAssign(null)} onDone={() => { setAssign(null); toast('Driver assigned', 'success'); reload(); }} />}
      {route && <RouteModal b={route} onClose={() => setRoute(null)} onDone={() => { setRoute(null); reload(); }} />}
    </div>
  );
}
