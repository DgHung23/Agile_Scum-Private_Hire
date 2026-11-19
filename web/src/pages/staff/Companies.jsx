import { useState } from 'react';
import { api } from '../../api.js';
import { fmtDate, money } from '../../format.js';
import { Alert, Empty, Loading, Modal, PageHeader, TextArea, TextField, useLoad, useToast } from '../../ui.jsx';

const STATUS = { pending: ['amber', 'Pending'], approved: ['green', 'Approved'], suspended: ['red', 'Suspended'], rejected: ['', 'Rejected'], closed: ['', 'Closed'] };

/** N07 approve or reject company applications with a credit limit; N10 invoice; N11 overdue check and suspension. */
export default function Companies() {
  const toast = useToast();
  const { data, loading, error, reload } = useLoad(() => api.get('/staff/companies'));
  const [modal, setModal] = useState(null);
  const act = async (fn, msg) => {
    try {
      await fn();
      toast(msg, 'success');
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  return (
    <div className="stack-lg">
      <PageHeader title="Company accounts" sub="Check the company number, then approve with a credit limit or reject with a reason. Reply within 2 working days."
        actions={<button className="btn btn-subtle" onClick={() => act(async () => { const r = await api.post('/staff/companies/billing-check'); toast(`${r.actions} overdue action(s)`, 'info'); }, 'Overdue check done')}>Run overdue check</button>} />
      {loading && <Loading />}
      {error && <Alert tone="error">{error.message}</Alert>}
      {data?.companies.length === 0 && <Empty icon="building" title="No company accounts yet" />}
      <div className="stack">
        {data?.companies.map((c) => {
          const [tone, label] = STATUS[c.status];
          return (
            <article key={c.id} className="card stack-sm">
              <div className="row-between">
                <span className="strong">{c.name} <span className="mono muted small">{c.companiesHouseNo}</span></span>
                <span className={`badge ${tone}`}>{label}</span>
              </div>
              <div className="small muted">
                Applied {fmtDate(c.createdAt)} by {c.applicant} ({c.applicantEmail}) &middot; finance {c.financeContact}, {c.financeEmail}
                {c.expectedSpend ? ` · expects ${money(c.expectedSpend)} a month` : ''}
              </div>
              <div className="small">{c.billingAddress}</div>
              {c.status !== 'pending' && <div className="small">Credit limit {c.creditLimit ? money(c.creditLimit) : '-'} &middot; {c.members} member(s) &middot; owed {money(c.owed)}{c.statusReason ? ` · ${c.statusReason}` : ''}</div>}
              <div className="row" style={{ gap: 8 }}>
                {c.status === 'pending' && <button className="btn btn-sm" onClick={() => setModal({ c, kind: 'approve' })}>Approve</button>}
                {c.status === 'pending' && <button className="btn btn-subtle btn-sm" onClick={() => setModal({ c, kind: 'reject' })}>Reject</button>}
                {['approved', 'suspended'].includes(c.status) && <button className="btn btn-secondary btn-sm" onClick={() => act(() => api.post(`/staff/companies/${c.id}/invoice`), 'Invoice issued and emailed')}>Issue invoice now</button>}
                {c.status === 'approved' && <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.post(`/staff/companies/${c.id}/status`, { status: 'suspended', reason: 'Suspended by the Manager' }), 'Suspended')}>Suspend</button>}
                {c.status === 'suspended' && <button className="btn btn-ghost btn-sm" onClick={() => act(() => api.post(`/staff/companies/${c.id}/status`, { status: 'approved' }), 'Reinstated')}>Reinstate</button>}
              </div>
            </article>
          );
        })}
      </div>
      {modal && <Decide {...modal} onClose={() => setModal(null)} onDone={(msg) => { setModal(null); toast(msg, 'success'); reload(); }} />}
    </div>
  );
}

function Decide({ c, kind, onClose, onDone }) {
  const [limit, setLimit] = useState('2000');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const go = async () => {
    try {
      if (kind === 'approve') await api.post(`/staff/companies/${c.id}/approve`, { creditLimit: Number(limit) });
      else await api.post(`/staff/companies/${c.id}/reject`, { reason });
      onDone(kind === 'approve' ? `${c.name} approved` : `${c.name} rejected - reason emailed`);
    } catch (x) {
      setErr(x.fields ? Object.values(x.fields)[0] : x.message);
    }
  };
  return (
    <Modal title={kind === 'approve' ? `Approve ${c.name}` : `Reject ${c.name}`} onClose={onClose}>
      <div className="stack">
        {err && <Alert tone="error">{err}</Alert>}
        {kind === 'approve' ? (
          <>
            <p className="small muted">Simulated checks: company number format OK, credit check passed. Set the monthly credit limit.</p>
            <TextField label="Monthly credit limit (GBP)" type="number" value={limit} onChange={(e) => setLimit(e.target.value)} />
          </>
        ) : (
          <TextArea label="Reason (emailed to the applicant)" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-subtle" onClick={onClose}>Close</button>
          <button className="btn" onClick={go}>{kind === 'approve' ? 'Approve' : 'Reject'}</button>
        </div>
      </div>
    </Modal>
  );
}
