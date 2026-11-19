import { useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { fmtShort, fmtTime, money } from '../format.js';
import { Alert, Empty, Loading, Modal, PageHeader, StatusBadge, TextArea, TextField, useLoad, useToast } from '../ui.jsx';
import { RouteLine } from '../components/BookingBits.jsx';

/**
 * Simulated Driver view (N34, N35, N36): a phone-sized list of my jobs with one big button for the next step.
 * Each button triggers the customer's texts (R6), the receipt (R8) and the review invitation (R9).
 */
export default function Driver() {
  const toast = useToast();
  const { data, loading, error, reload } = useLoad(() => api.get('/driver/jobs'));
  const [modal, setModal] = useState(null); // { job, kind }
  const act = async (job, body, msg) => {
    try {
      await api.post(`/driver/jobs/${job.id}/status`, body);
      toast(msg, 'success');
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  if (loading) return <div className="container page"><Loading /></div>;
  if (error) return <div className="container page"><Alert tone="error">{error.message}</Alert></div>;
  const active = data.jobs.filter((j) => !['completed', 'no_show'].includes(j.status));
  const finished = data.jobs.filter((j) => ['completed', 'no_show'].includes(j.status));
  return (
    <div className="container page">
      <div className="narrow stack-lg">
        <PageHeader title="My jobs" sub={`${data.driver.name} - licence ${data.driver.licenceNo}`} actions={<button className="btn btn-subtle btn-sm" onClick={reload}>Refresh</button>} />
        {active.length === 0 && <Empty icon="wheel" title="No jobs right now">New jobs appear here when the control room assigns them.</Empty>}
        {active.map((j) => (
          <article key={j.id} className="card stack">
            <div className="row-between" style={{ alignItems: 'flex-start' }}>
              <div>
                <div className="strong" style={{ fontSize: 22 }}>{fmtTime(j.pickupAt)}</div>
                <div className="small muted">{fmtShort(j.pickupAt)} &middot; <span className="mono">{j.ref}</span> &middot; {j.service}{j.package ? ` (${j.package})` : ''}</div>
              </div>
              <StatusBadge status={j.status} />
            </div>
            <RouteLine pickup={j.pickup} destination={j.destination} />
            <div className="small">
              {j.passengerFirstName}, {j.passengers} passenger{j.passengers === 1 ? '' : 's'}{j.luggage ? `, ${j.luggage} bag${j.luggage === 1 ? '' : 's'}` : ''} &middot;{' '}
              <a href={`tel:${j.contactPhone}`} className="strong">{j.contactPhone}</a>
            </div>
            {(j.childSeatAges.length > 0 || j.pet || j.accessibility.length > 0 || j.flightNo || j.noteToDriver) && (
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {j.childSeatAges.length > 0 && <li>{j.childSeatAges.length} child seat(s), ages {j.childSeatAges.join(', ')}</li>}
                {j.pet && <li>Pet travelling</li>}
                {j.accessibility.map((a) => <li key={a}><strong>{a}</strong></li>)}
                {j.flightNo && <li>Flight {j.flightNo} - follow the landing time</li>}
                {j.noteToDriver && <li>Note: {j.noteToDriver}</li>}
              </ul>
            )}
            <div className="small muted"><Icon name="car" size={14} /> {j.vehicle.reg} - {j.vehicle.colour} {j.vehicle.make} {j.vehicle.model}</div>
            {j.payOnCompletion != null && <Alert tone="info">Collect {money(j.payOnCompletion)} in cash at the end.</Alert>}

            {j.status === 'assigned' && <button className="btn btn-lg btn-block" onClick={() => setModal({ job: j, kind: 'eta' })}>On my way</button>}
            {j.status === 'on_route' && <button className="btn btn-lg btn-block" onClick={() => act(j, { status: 'arrived' }, 'Customer told you have arrived')}>Arrived</button>}
            {j.status === 'arrived' && <button className="btn btn-lg btn-block" onClick={() => act(j, { status: 'in_progress' }, 'Journey started')}>Picked up</button>}
            {j.status === 'arrived' && (
              <button className="btn btn-subtle btn-block" onClick={() => act(j, { status: 'no_show' }, 'Recorded as a no-show')}>
                Customer not here (after 10 minutes)
              </button>
            )}
            {j.status === 'in_progress' && (
              <button className="btn btn-lg btn-block" onClick={() => (j.payOnCompletion != null ? setModal({ job: j, kind: 'cash' }) : act(j, { status: 'completed' }, 'Job completed'))}>
                Completed
              </button>
            )}
            {j.status === 'interrupted' && <Alert tone="warn">Journey interrupted. The control room is sending a replacement car.</Alert>}
            <div className="row" style={{ gap: 8 }}>
              {['assigned', 'on_route'].includes(j.status) && <button className="btn btn-ghost btn-sm" onClick={() => setModal({ job: j, kind: 'late' })}>Running late</button>}
              {['on_route', 'arrived', 'in_progress'].includes(j.status) && <button className="btn btn-ghost btn-sm" onClick={() => setModal({ job: j, kind: 'breakdown' })}>Report breakdown</button>}
              <button className="btn btn-ghost btn-sm" onClick={() => setModal({ job: j, kind: 'found_item' })}>Found item</button>
            </div>
          </article>
        ))}
        {finished.length > 0 && (
          <section className="stack-sm">
            <h3>Finished today</h3>
            {finished.map((j) => (
              <div key={j.id} className="row-between small card">
                <span><span className="mono">{j.ref}</span> {fmtTime(j.pickupAt)} {j.pickup} &rarr; {j.destination}</span>
                <span className="row" style={{ gap: 8 }}>
                  <StatusBadge status={j.status} />
                  <button className="btn btn-ghost btn-sm" onClick={() => setModal({ job: j, kind: 'found_item' })}>Found item</button>
                </span>
              </div>
            ))}
          </section>
        )}
      </div>
      {modal && <DriverModal {...modal} onClose={() => setModal(null)} onDone={(msg) => { setModal(null); toast(msg, 'success'); reload(); }} />}
    </div>
  );
}

function DriverModal({ job, kind, onClose, onDone }) {
  const [value, setValue] = useState(kind === 'eta' ? '10' : '');
  const [cash, setCash] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const titles = { eta: 'On my way', late: 'Running late', breakdown: 'Report a breakdown', found_item: 'Found item', cash: 'Complete and collect cash' };
  const go = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      if (kind === 'eta') await api.post(`/driver/jobs/${job.id}/status`, { status: 'on_route', etaMinutes: Number(value) });
      if (kind === 'late') await api.post(`/driver/jobs/${job.id}/late`, { minutes: Number(value) });
      if (kind === 'breakdown' || kind === 'found_item') await api.post(`/driver/jobs/${job.id}/report`, { kind, message: value });
      if (kind === 'cash') await api.post(`/driver/jobs/${job.id}/status`, { status: 'completed', cashCollected: cash });
      onDone({ eta: 'Customer told you are on the way', late: 'Customer told about the delay', breakdown: 'Control room told - stay safe', found_item: 'Found item logged', cash: 'Job completed - receipt sent' }[kind]);
    } catch (x) {
      setErr(x.fields ? Object.values(x.fields)[0] : x.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={titles[kind]} onClose={onClose}>
      <form className="stack" onSubmit={go} noValidate>
        {err && <Alert tone="error">{err}</Alert>}
        {kind === 'eta' && <TextField label="Minutes to pickup" type="number" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} hint="At 15 minutes or less the customer gets a text with your car details." />}
        {kind === 'late' && <TextField label="How many minutes late?" type="number" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} hint="More than 15 minutes late lets the customer cancel free of charge." />}
        {kind === 'breakdown' && (
          <>
            <Alert tone="error" icon="alert">If anyone is hurt, call 999 first.</Alert>
            <TextArea label="What happened and where?" rows={3} value={value} onChange={(e) => setValue(e.target.value)} />
          </>
        )}
        {kind === 'found_item' && <TextArea label="Describe the item (what, colour, where in the car)" rows={3} value={value} onChange={(e) => setValue(e.target.value)} />}
        {kind === 'cash' && (
          <label className="check"><input type="checkbox" checked={cash} onChange={(e) => setCash(e.target.checked)} /><span>I collected {money(job.payOnCompletion)} in cash</span></label>
        )}
        <button className="btn btn-lg btn-block" disabled={busy || (kind === 'cash' && !cash)}>{busy ? 'Sending...' : 'Confirm'}</button>
      </form>
    </Modal>
  );
}
