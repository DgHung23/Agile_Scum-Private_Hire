import { useState } from 'react';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { fmtDate, fmtShort } from '../../format.js';
import { Alert, Empty, Loading, Modal, PageHeader, TextArea, TextField, useLoad, useToast } from '../../ui.jsx';

const LOST = { reported: 'Reported', searching: 'Searching', found: 'Found', ready: 'Ready to collect', sent: 'Sent by courier', returned: 'Returned', not_found: 'Not found' };

/** Staff support desk: lost property (N23, N28) and complaints (N24, N33). */
export default function SupportDesk() {
  const { user } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('lost');
  const lost = useLoad(() => api.get('/staff/lost-items?open=false'));
  const complaints = useLoad(() => api.get('/staff/complaints'));
  const [found, setFound] = useState({ bookingRef: '', description: '', colour: '' });
  const [errs, setErrs] = useState({});
  const [answer, setAnswer] = useState(null);
  const [action, setAction] = useState(null);

  const logFound = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/staff/lost-items', found);
      toast(r.item.matchedWith ? 'Logged and matched to a customer report' : 'Found item logged', 'success');
      setFound({ bookingRef: '', description: '', colour: '' });
      setErrs({});
      lost.reload();
    } catch (x) {
      setErrs(x.fields || {});
    }
  };
  const setStatus = async (i, status) => {
    try {
      await api.patch(`/staff/lost-items/${i.id}`, { status });
      toast('Updated - customer told', 'success');
      lost.reload();
    } catch (x) {
      toast(x.message, 'error');
    }
  };
  const match = async (i, otherId) => {
    await api.patch(`/staff/lost-items/${i.id}`, { matchedWith: otherId });
    toast('Matched', 'success');
    lost.reload();
  };
  const unmatched = (kind) => (lost.data?.items || []).filter((x) => x.kind === kind && !x.matchedWith && !['returned', 'not_found'].includes(x.status));

  return (
    <div className="stack-lg">
      <PageHeader title="Support" sub="Lost property and complaints. Complaints must be answered within 5 working days." />
      <div className="chips" role="tablist">
        <button className={`chip ${tab === 'lost' ? 'active' : ''}`} onClick={() => setTab('lost')}>Lost property</button>
        <button className={`chip ${tab === 'complaints' ? 'active' : ''}`} onClick={() => setTab('complaints')}>
          Complaints{complaints.data ? ` (${complaints.data.complaints.filter((c) => c.status === 'open').length} open)` : ''}
        </button>
      </div>
      {tab === 'lost' && (
        <>
          <form className="card form-grid four" onSubmit={logFound} noValidate>
            <TextField label="Booking reference" value={found.bookingRef} onChange={(e) => setFound({ ...found, bookingRef: e.target.value.toUpperCase() })} error={errs.bookingRef} />
            <TextField label="Found item" value={found.description} onChange={(e) => setFound({ ...found, description: e.target.value })} error={errs.description} />
            <TextField label="Colour" value={found.colour} onChange={(e) => setFound({ ...found, colour: e.target.value })} />
            <div><button className="btn">Log found item</button></div>
          </form>
          {lost.loading && <Loading />}
          {lost.data?.items.length === 0 && <Empty icon="inbox" title="No lost property" />}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Logged</th><th>Type</th><th>Item</th><th>Booking</th><th>Customer</th><th>Status</th><th>Match</th></tr></thead>
              <tbody>
                {lost.data?.items.map((i) => (
                  <tr key={i.id}>
                    <td className="small">{fmtShort(i.createdAt)}</td>
                    <td>{i.kind === 'found' ? 'Found' : 'Reported'}</td>
                    <td>{i.description}{i.colour ? ` (${i.colour})` : ''}</td>
                    <td className="mono small">{i.ref || '-'}</td>
                    <td className="small">{i.customer?.name || '-'}</td>
                    <td>
                      <select className="input" aria-label="Status" value={i.status} onChange={(e) => setStatus(i, e.target.value)} style={{ minWidth: 150 }}>
                        {Object.entries(LOST).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </td>
                    <td className="small">
                      {i.matchedWith ? 'Matched' : (
                        <select className="input" aria-label="Match with" value="" onChange={(e) => e.target.value && match(i, e.target.value)}>
                          <option value="">Match with...</option>
                          {unmatched(i.kind === 'found' ? 'reported' : 'found').map((o) => <option key={o.id} value={o.id}>{o.description} ({o.ref})</option>)}
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {tab === 'complaints' && (
        <div className="stack">
          {complaints.data?.complaints.length === 0 && <Empty icon="message" title="No complaints" />}
          {complaints.data?.complaints.map((c) => (
            <article key={c.id} className="card stack-sm">
              <div className="row-between">
                <span className="strong">{c.customer}{c.ref ? <span className="mono muted"> - {c.ref}</span> : ''} &middot; {c.category}</span>
                <span className={`badge ${c.status !== 'open' ? 'green' : c.overdue ? 'red' : 'amber'}`}>{c.status !== 'open' ? 'Answered' : c.overdue ? 'Overdue' : `Due ${fmtDate(c.dueBy)}`}</span>
              </div>
              <p className="small">{c.text}</p>
              {c.driver && <p className="tiny">Driver: {c.driver}</p>}
              {c.answer && <Alert tone="info">{c.answer}</Alert>}
              {c.driverAction && <p className="tiny"><strong>Manager action:</strong> {c.driverAction}</p>}
              <div className="row">
                {c.status === 'open' && <button className="btn btn-sm" onClick={() => setAnswer(c)}>Answer</button>}
                {user.role === 'manager' && c.driver && !c.driverAction && <button className="btn btn-subtle btn-sm" onClick={() => setAction(c)}>Act on driver</button>}
              </div>
            </article>
          ))}
        </div>
      )}
      {answer && <Reply title="Answer the complaint" label="Answer (emailed to the customer)" onClose={() => setAnswer(null)}
        submit={(text) => api.post(`/staff/complaints/${answer.id}/answer`, { answer: text })} onDone={() => { setAnswer(null); toast('Answer sent', 'success'); complaints.reload(); }} />}
      {action && <Reply title={`Act on ${action.driver}`} label="Action (warning, retraining, suspension)" suspend onClose={() => setAction(null)}
        submit={(text, suspendDriver) => api.post(`/staff/complaints/${action.id}/driver-action`, { action: text, suspendDriver })} onDone={() => { setAction(null); toast('Recorded', 'success'); complaints.reload(); }} />}
    </div>
  );
}

function Reply({ title, label, suspend, submit, onClose, onDone }) {
  const [text, setText] = useState('');
  const [sus, setSus] = useState(false);
  const [err, setErr] = useState('');
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        {err && <Alert tone="error">{err}</Alert>}
        <TextArea label={label} rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        {suspend && <label className="check"><input type="checkbox" checked={sus} onChange={(e) => setSus(e.target.checked)} /><span>Suspend the driver (cannot be assigned)</span></label>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-subtle" onClick={onClose}>Close</button>
          <button className="btn" onClick={async () => { try { await submit(text, sus); onDone(); } catch (x) { setErr(x.fields ? Object.values(x.fields)[0] : x.message); } }}>Save</button>
        </div>
      </div>
    </Modal>
  );
}

