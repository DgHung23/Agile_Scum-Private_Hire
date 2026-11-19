import { useState } from 'react';
import { api, qs } from '../../api.js';
import { fmtDateTime } from '../../format.js';
import { Alert, Empty, Loading, PageHeader, TextArea, useLoad, useToast } from '../../ui.jsx';

/** US2.3: staff inbox, newest first, with status. Replying emails the customer and marks it Replied. */
export default function StaffEnquiries() {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const { data, loading, error, reload } = useLoad(() => api.get('/staff/enquiries' + qs({ status })), [status]);
  const [openId, setOpenId] = useState(null);
  const [reply, setReply] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async (e) => {
    setErr('');
    setBusy(true);
    try {
      await api.post(`/staff/enquiries/${e.id}/reply`, { message: reply });
      toast('Reply emailed to ' + e.email, 'success');
      setReply('');
      setOpenId(null);
      reload();
    } catch (x) {
      setErr(x.fields?.message || x.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-lg">
      <PageHeader title="Enquiries" sub="Questions from customers and visitors, newest first." />
      <div className="chips" role="tablist">
        {[['', `All`], ['new', `New${data ? ` (${data.counts.new})` : ''}`], ['replied', `Replied${data ? ` (${data.counts.replied})` : ''}`]].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={status === k} className={`chip ${status === k ? 'active' : ''}`} onClick={() => setStatus(k)}>{l}</button>
        ))}
      </div>
      {loading && !data && <Loading />}
      {error && <Alert tone="error">{error.message}</Alert>}
      {data && data.enquiries.length === 0 && <Empty icon="message" title="No enquiries here" />}
      <div className="stack">
        {data?.enquiries.map((e) => {
          const open = openId === e.id;
          return (
            <article key={e.id} className="card stack-sm">
              <div className="row-between" style={{ alignItems: 'flex-start' }}>
                <div>
                  <div className="strong">{e.subject}</div>
                  <div className="small muted">{e.name} &middot; {e.email} &middot; {fmtDateTime(e.createdAt)}</div>
                </div>
                <div className="row">
                  {e.bookingRef && <span className="badge blue">Trip {e.bookingRef}</span>}
                  <span className={`badge ${e.status === 'new' ? 'amber' : 'green'}`}>{e.status === 'new' ? 'New' : 'Replied'}</span>
                </div>
              </div>
              <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{e.message}</p>
              {e.replies.map((r) => (
                <div key={r.id} className="msg">
                  <div className="meta">{r.staffName} replied {fmtDateTime(r.createdAt)}</div>
                  <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{r.body}</p>
                </div>
              ))}
              {open ? (
                <div className="stack-sm">
                  {err && <Alert tone="error">{err}</Alert>}
                  <TextArea label={`Reply to ${e.name}`} value={reply} onChange={(x) => setReply(x.target.value)} maxLength={3000} />
                  <div className="row">
                    <button className="btn" disabled={busy} onClick={() => send(e)}>{busy ? 'Sending...' : 'Send reply by email'}</button>
                    <button className="btn btn-subtle" onClick={() => { setOpenId(null); setErr(''); }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div><button className="btn btn-secondary btn-sm" onClick={() => { setOpenId(e.id); setReply(''); setErr(''); }}>{e.status === 'new' ? 'Reply' : 'Reply again'}</button></div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
