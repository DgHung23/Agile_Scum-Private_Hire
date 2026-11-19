import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Icon } from '../../icons.jsx';
import { CHANNEL_LABEL, PAYMENT_STATUS_LABEL, STATUS_LABEL, fmtDateTime, fmtShort, money } from '../../format.js';
import { Alert, Kv, Loading, Modal, PageHeader, SelectField, StatusBadge, TextArea, TextField, useLoad, useToast } from '../../ui.jsx';
import { BookingExtras, PriceBreakdown, RouteLine } from '../../components/BookingBits.jsx';

/**
 * Staff view of one booking with every action the report gives Call Centre Staff and Managers:
 * assign / replace car (ID-67, N30), journey status (ID-68), running late (ID-45), refund up to the limit (N27),
 * extra charge (N31), change of destination (N26), cancel for a caller with a reason (ID-77, N18),
 * company cancellation after offering alternatives (ID-78), and the status history (who did what, when).
 */
export default function BookingManage() {
  const { id } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useLoad(() => api.get(`/staff/bookings/${id}`), [id]);
  const history = useLoad(() => api.get(`/staff/bookings/${id}/history`), [id]);
  const [modal, setModal] = useState(null);
  const refreshAll = () => {
    reload();
    history.reload();
  };
  const act = async (fn, msg) => {
    try {
      await fn();
      toast(msg, 'success');
      refreshAll();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  if (loading) return <Loading />;
  if (error) return <Alert tone="error">{error.message}</Alert>;
  const b = data.booking;
  const s = b.status;
  const post = (path, body) => api.post(`/staff/bookings/${id}${path}`, body);
  const close = () => setModal(null);
  const done = (msg) => {
    setModal(null);
    toast(msg, 'success');
    refreshAll();
  };

  return (
    <div className="stack-lg">
      <div><Link to="/staff/dispatch" className="small strong">&larr; Dispatch</Link></div>
      <PageHeader title={<span className="mono">{b.ref}</span>} sub={`${fmtDateTime(b.pickupAt)} - ${b.service.label} - ${CHANNEL_LABEL[b.channel]}`}
        actions={<StatusBadge status={s} />} />
      {s === 'interrupted' && <Alert tone="error" icon="alert">Interrupted. Send a replacement car of the same size; the fare must not rise.</Alert>}
      {b.lateMinutes > 15 && <Alert tone="warn">Driver reported running late; the customer may cancel free of charge.</Alert>}

      <section className="card stack">
        <h3>Next step</h3>
        <div className="row" style={{ gap: 8 }}>
          {['confirmed', 'assigned', 'interrupted'].includes(s) && (
            <button className="btn btn-sm" onClick={() => setModal('assign')}><Icon name="wheel" size={16} /> {s === 'interrupted' ? 'Send replacement car' : s === 'assigned' ? 'Change driver or car' : 'Assign driver'}</button>
          )}
          {['assigned', 'on_route'].includes(s) && <button className="btn btn-sm" onClick={() => setModal('route')}>{s === 'on_route' ? 'Update ETA' : 'On route'}</button>}
          {s === 'on_route' && <button className="btn btn-sm" onClick={() => act(() => post('/status', { status: 'arrived' }), 'Marked as arrived - customer told')}>Arrived</button>}
          {s === 'arrived' && <button className="btn btn-sm" onClick={() => act(() => post('/status', { status: 'in_progress' }), 'Customer picked up')}>Picked up</button>}
          {s === 'arrived' && <button className="btn btn-subtle btn-sm" onClick={() => act(() => post('/status', { status: 'no_show' }), 'Recorded as a no-show')}>No-show (after 10 min)</button>}
          {['in_progress', 'interrupted'].includes(s) && <button className="btn btn-sm" onClick={() => setModal('complete')}>Complete journey</button>}
          {['on_route', 'arrived', 'in_progress'].includes(s) && <button className="btn btn-subtle btn-sm" onClick={() => setModal('interrupt')}>Car cannot continue</button>}
          {['assigned', 'on_route'].includes(s) && <button className="btn btn-subtle btn-sm" onClick={() => setModal('late')}>Driver running late</button>}
          {['assigned', 'on_route', 'arrived', 'in_progress', 'interrupted'].includes(s) && <button className="btn btn-subtle btn-sm" onClick={() => setModal('destination')}>Change destination</button>}
          {['confirmed', 'assigned'].includes(s) && <button className="btn btn-subtle btn-sm" onClick={() => setModal('cancel')}>Cancel for caller</button>}
          {['confirmed', 'assigned'].includes(s) && <button className="btn btn-ghost btn-sm" onClick={() => setModal('company')}>Company cancels</button>}
        </div>
      </section>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <section className="card stack">
          <h3>Journey</h3>
          <RouteLine pickup={b.pickup} destination={b.destination} />
          <Kv k="Customer" v={<Link to={`/staff/call-desk/${b.customer.id}`} className="strong">{b.customer.name}</Link>} />
          <Kv k="Phone" v={b.customer.phone} />
          <Kv k="Passengers" v={b.passengers} />
          <Kv k="Cab" v={b.vehicle ? `${b.size.label} - ${b.vehicle.reg} (${b.vehicle.colour} ${b.vehicle.make})` : b.size.label} />
          {b.driver && <Kv k="Driver" v={`${b.driver.name} (${b.driver.phone})`} />}
          {b.etaMinutes != null && <Kv k="ETA" v={`${b.etaMinutes} min`} />}
          <BookingExtras b={b} />
        </section>
        <section className="card stack">
          <h3>Money</h3>
          <PriceBreakdown price={b.price} />
          <Kv k="Payment" v={PAYMENT_STATUS_LABEL[b.paymentStatus] || b.paymentStatus} />
          {data.payments.map((p) => (
            <div key={p.id} className="small muted">
              {fmtShort(p.createdAt)} {p.kind === 'refund' ? 'Refund' : 'Charge'} {money(p.amount)} - {p.method}{p.reason ? ` - ${p.reason}` : ''}
            </div>
          ))}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setModal('refund')}>Refund</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setModal('charge')}>Extra charge</button>
          </div>
          <p className="tiny">{user.role === 'staff' ? `Your refund limit: ${money(user.refundLimit ?? 50)} per booking per day. Above that, a Manager approves.` : 'Managers can refund any amount.'}</p>
        </section>
      </div>

      <section className="card stack">
        <h3>History</h3>
        {history.data?.events.map((e) => (
          <div key={e.id} className="row-between small">
            <span><strong>{STATUS_LABEL[e.status] || e.status}</strong>{e.reason ? ` - ${e.reason}` : ''}</span>
            <span className="muted">{e.by ? `${e.by} (${e.role})` : 'System'} &middot; {fmtShort(e.at)}</span>
          </div>
        ))}
        {history.data?.assignments.length > 0 && <div className="label" style={{ marginTop: 8 }}>Cars and drivers</div>}
        {history.data?.assignments.map((a) => (
          <div key={a.id} className="small muted">
            <span className="mono">{a.reg}</span> - {a.driver}, dispatched by {a.dispatchedBy || 'system'} {fmtShort(a.assignedAt)}{a.endedAt ? `, ended ${fmtShort(a.endedAt)} (${a.endReason})` : ''}
          </div>
        ))}
      </section>

      {modal === 'assign' && <AssignModal b={b} replacing={s === 'interrupted'} onClose={close} onDone={() => done(s === 'interrupted' ? 'Replacement sent - customer texted' : 'Driver assigned')} />}
      {modal === 'route' && <SimpleForm title="Driver on route" fields={[['etaMinutes', 'ETA in minutes', 'number']]} submit={(v) => post('/status', { status: 'on_route', etaMinutes: Number(v.etaMinutes) })} onClose={close} onDone={() => done('On route - texts sent where due')} />}
      {modal === 'late' && <SimpleForm title="Driver running late" fields={[['minutes', 'Minutes late', 'number']]} submit={(v) => post('/late', { minutes: Number(v.minutes) })} onClose={close} onDone={() => done('Customer told about the delay')} />}
      {modal === 'interrupt' && <SimpleForm title="Car cannot continue" note="The car becomes Unavailable until a Manager clears it. If anyone is hurt, call 999 first." fields={[['reason', 'What happened and where', 'textarea']]} submit={(v) => post('/status', { status: 'interrupted', reason: v.reason })} onClose={close} onDone={() => done('Journey interrupted - customer told')} />}
      {modal === 'complete' && <SimpleForm title="Complete journey" fields={b.paymentStatus === 'due_cash' ? [['cash', `Cash of ${money(b.price.total)} collected`, 'checkbox']] : []} submit={(v) => post('/status', { status: 'completed', cashCollected: !!v.cash })} onClose={close} onDone={() => done('Journey completed - review invitation sent')} />}
      {modal === 'destination' && <SimpleForm title="Change destination" note="The price is recalculated and the difference charged or refunded." fields={[['destination', 'New destination', 'text']]} submit={(v) => post('/destination', { destination: v.destination })} onClose={close} onDone={() => done('Destination changed')} />}
      {modal === 'refund' && <SimpleForm title="Refund" fields={[['amount', 'Amount (GBP)', 'number'], ['reason', 'Reason (the customer sees it)', 'textarea']]} submit={(v) => post('/refund', { amount: Number(v.amount), reason: v.reason })} onClose={close} onDone={() => done('Refund issued - credit note created')} />}
      {modal === 'charge' && (
        <SimpleForm title="Extra charge" note="Charged to the original card or account. The customer can dispute it." fields={[['kind', 'Type', 'select', [['cleaning', 'Cleaning'], ['damage', 'Damage'], ['no_show', 'No-show'], ['late_cancellation', 'Late cancellation'], ['other', 'Other']]], ['amount', 'Amount (GBP)', 'number'], ['reason', 'Reason (the customer sees it)', 'textarea']]}
          submit={(v) => post('/charge', { kind: v.kind || 'cleaning', amount: Number(v.amount), reason: v.reason })} onClose={close} onDone={() => done('Charge taken - receipt sent')} />
      )}
      {modal === 'cancel' && (
        <SimpleForm title="Cancel for the caller" note="Inside 24 hours you may keep the late-cancellation fee (50%)." fields={[['reason', 'Reason', 'textarea'], ['lateFee', 'Keep the late-cancellation fee', 'checkbox']]}
          submit={(v) => post('/cancel', { reason: v.reason, lateFee: !!v.lateFee })} onClose={close} onDone={() => done('Cancelled - refund and credit note issued')} />
      )}
      {modal === 'company' && <CompanyCancel b={b} onClose={close} onDone={() => done('Cancelled by us - full refund and apology sent')} />}
    </div>
  );
}

function SimpleForm({ title, note, fields, submit, onClose, onDone }) {
  const [v, setV] = useState({});
  const [errors, setErrors] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await submit(v);
      onDone();
    } catch (x) {
      setErrors(x.fields || {});
      setErr(x.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={go} noValidate>
        {note && <p className="small muted">{note}</p>}
        {err && <Alert tone="error">{err}</Alert>}
        {fields.map(([k, label, type, opts]) =>
          type === 'textarea' ? (
            <TextArea key={k} label={label} rows={3} value={v[k] || ''} error={errors[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
          ) : type === 'checkbox' ? (
            <label key={k} className="check"><input type="checkbox" checked={!!v[k]} onChange={(e) => setV({ ...v, [k]: e.target.checked })} /><span>{label}</span></label>
          ) : type === 'select' ? (
            <SelectField key={k} label={label} value={v[k] || opts[0][0]} onChange={(e) => setV({ ...v, [k]: e.target.value })}>
              {opts.map(([o, l]) => <option key={o} value={o}>{l}</option>)}
            </SelectField>
          ) : (
            <TextField key={k} label={label} type={type} value={v[k] || ''} error={errors[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
          ),
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-subtle" onClick={onClose}>Close</button>
          <button className="btn" disabled={busy}>{busy ? 'Saving...' : 'Confirm'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** ID-67 assign, N30 replacement (a car of the same size or bigger; the fare does not change). */
export function AssignModal({ b, replacing = false, onClose, onDone }) {
  const { data, loading } = useLoad(() => api.get(`/staff/bookings/${b.id}/options`), [b.id]);
  const [driverId, setDriverId] = useState('');
  const [cabId, setCabId] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await api.post(`/staff/bookings/${b.id}/assign`, { driverId, ...(cabId ? { cabId } : {}) });
      onDone();
    } catch (x) {
      setErr(x.message);
      setBusy(false);
    }
  };
  const cabs = (data?.cabs || []).filter((c) => !replacing || !c.current);
  return (
    <Modal title={replacing ? 'Send a replacement car' : `Assign a driver - ${b.ref}`} onClose={onClose}>
      <div className="stack">
        {loading && <Loading />}
        {err && <Alert tone="error">{err}</Alert>}
        {data && (
          <>
            <p className="small muted">Only drivers and cars that are free and have valid documents are listed.</p>
            <SelectField label="Driver" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              <option value="">Choose a free driver</option>
              {data.drivers.map((d) => <option key={d.id} value={d.id}>{d.fullName}</option>)}
            </SelectField>
            <SelectField label={replacing ? 'Replacement car' : 'Car (optional)'} value={cabId} onChange={(e) => setCabId(e.target.value)}>
              <option value="">{replacing ? 'Choose a car' : 'Keep the reserved car'}</option>
              {cabs.map((c) => <option key={c.id} value={c.id}>{c.reg} - {c.colour} {c.make} {c.model} ({c.sizeLabel}){c.wheelchairAccessible ? ', wheelchair accessible' : ''}</option>)}
            </SelectField>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn btn-subtle" onClick={onClose}>Close</button>
              <button className="btn" onClick={go} disabled={busy || !driverId || (replacing && !cabId)}>{busy ? 'Saving...' : replacing ? 'Send replacement' : 'Assign'}</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** ID-78: offer another time or size first; cancel with a full refund and apology only if the customer declines. */
function CompanyCancel({ b, onClose, onDone }) {
  const { data, loading } = useLoad(() => api.get(`/staff/bookings/${b.id}/alternatives`), [b.id]);
  const [offered, setOffered] = useState(false);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const go = async () => {
    try {
      await api.post(`/staff/bookings/${b.id}/company-cancel`, { reason, alternativesOffered: offered });
      onDone();
    } catch (x) {
      setErr(x.fields?.alternativesOffered || x.fields?.reason || x.message);
    }
  };
  return (
    <Modal title="Company cancellation" onClose={onClose}>
      <div className="stack">
        <p className="small">First offer the customer another time or cab size. If they accept, use Change booking on the caller's page instead.</p>
        {loading && <Loading />}
        {data && (
          <div className="stack-sm small">
            <div><strong>Other sizes at this time:</strong> {data.alternatives.sizes.map((x) => x.label).join(', ') || 'none'}</div>
            <div><strong>Other times:</strong> {data.alternatives.times.map((x) => fmtShort(x)).join(', ') || 'none'}</div>
          </div>
        )}
        {err && <Alert tone="error">{err}</Alert>}
        <label className="check"><input type="checkbox" checked={offered} onChange={(e) => setOffered(e.target.checked)} /><span>I offered these and the customer declined</span></label>
        <TextArea label="Reason (in the apology email)" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-subtle" onClick={onClose}>Close</button>
          <button className="btn" onClick={go} disabled={!offered || reason.trim().length < 3}>Cancel with full refund</button>
        </div>
      </div>
    </Modal>
  );
}
