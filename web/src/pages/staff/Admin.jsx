import { useState } from 'react';
import { api, qs } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { fmtShort } from '../../format.js';
import { Icon } from '../../icons.jsx';
import { Alert, Empty, Loading, Modal, PageHeader, SelectField, TextField, useLoad, useToast } from '../../ui.jsx';
import { v, validate } from '../../validators.js';

const ROLE_LABEL = { staff: 'Call Centre Staff', manager: 'Manager', admin: 'Admin', driver: 'Driver' };

/** N01: Admin creates staff accounts and gives roles. */
export function StaffAccounts() {
  const { user } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload } = useLoad(() => api.get('/admin/staff'));
  const [adding, setAdding] = useState(false);

  const update = async (s, patch, msg) => {
    try {
      await api.patch(`/admin/staff/${s.id}`, patch);
      toast(msg, 'success');
      reload();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="stack-lg">
      <PageHeader
        title="Staff accounts"
        sub="Create accounts for Call Centre Staff, Managers, Admins and Drivers, and change their roles."
        actions={<button className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={18} /> New staff account</button>}
      />
      {loading && <Loading />}
      {error && <Alert tone="error">{error.message}</Alert>}
      {data && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Role</th><th>Refund limit</th><th>Last sign-in</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data.staff.map((s) => (
                <tr key={s.id}>
                  <td><div className="strong">{s.fullName}</div><div className="tiny muted">{s.email}</div></td>
                  <td>
                    <select className="input" style={{ minWidth: 170 }} value={s.role} disabled={s.id === user.id}
                      aria-label={`Role of ${s.fullName}`} onChange={(e) => update(s, { role: e.target.value }, `${s.fullName} is now ${ROLE_LABEL[e.target.value]}`)}>
                      {Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </td>
                  <td>{s.role === 'staff' ? `£${Number(s.refundLimit ?? 0).toFixed(0)} per booking per day` : s.role === 'manager' ? 'Any amount' : '-'}</td>
                  <td className="small">{s.lastLoginAt ? fmtShort(s.lastLoginAt) : 'Never'}</td>
                  <td>{s.isActive ? <span className="badge green">Active</span> : <span className="badge">Deactivated</span>}</td>
                  <td>
                    {s.id !== user.id && (
                      <button className="btn btn-ghost btn-sm" onClick={() => update(s, { isActive: !s.isActive }, s.isActive ? `${s.fullName} deactivated` : `${s.fullName} reactivated`)}>
                        {s.isActive ? 'Deactivate' : 'Reactivate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <NewStaff onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
    </div>
  );
}

function NewStaff({ onClose, onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ fullName: '', email: '', phone: '', role: 'staff', password: '' });
  const [errors, setErrors] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    const errs = validate(f, { fullName: v.required('Full name'), email: v.email, phone: v.phone, password: (x) => (x ? v.password(x) : '') });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api.post('/admin/staff', f);
      toast(f.password ? 'Account created' : 'Account created - we emailed a link to choose a password', 'success');
      onDone();
    } catch (x) {
      setErrors(x.fields || {});
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New staff account" onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        {err && <Alert tone="error">{err}</Alert>}
        <TextField label="Full name" value={f.fullName} onChange={set('fullName')} error={errors.fullName} />
        <TextField label="Work email" type="email" value={f.email} onChange={set('email')} error={errors.email} />
        <TextField label="Telephone" type="tel" value={f.phone} onChange={set('phone')} error={errors.phone} />
        <SelectField label="Role" value={f.role} onChange={set('role')}>
          {Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </SelectField>
        <TextField label="Initial password (optional)" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} error={errors.password}
          hint="Leave empty to email the new member a link to choose their own password." />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-subtle" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy}>{busy ? 'Creating...' : 'Create account'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** N04: Admin changes system settings (discount %, cancellation window, refund limit and more). */
export function Settings() {
  const toast = useToast();
  const { data, loading, error, reload } = useLoad(() => api.get('/admin/settings'));
  const [draft, setDraft] = useState({});
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api.put('/admin/settings', draft);
      toast('Settings saved', 'success');
      setDraft({});
      reload();
    } catch (e) {
      setErrors(e.fields || {});
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-lg">
      <PageHeader title="Settings" sub="Business rules used across the system. Every change is written to the audit log." />
      {loading && <Loading />}
      {error && <Alert tone="error">{error.message}</Alert>}
      {data && (
        <section className="card stack">
          {data.settings.filter((s) => s.editable).map((s) => (
            <TextField key={s.key} label={s.description || s.key} type="number" inputMode="numeric"
              value={draft[s.key] ?? s.value} error={errors[s.key]} hint={`Allowed: ${s.range[0]} to ${s.range[1]}`}
              onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })} />
          ))}
          <div><button className="btn" onClick={save} disabled={busy || !Object.keys(draft).length}>{busy ? 'Saving...' : 'Save settings'}</button></div>
        </section>
      )}
      <Jobs />
    </div>
  );
}

/** N03: audit log of staff actions (who, what, when). */
export function AuditLog() {
  const [filters, setFilters] = useState({ action: '', from: '', to: '' });
  const [applied, setApplied] = useState(filters);
  const { data, loading, error } = useLoad(() => api.get('/admin/audit' + qs(applied)), [applied]);
  return (
    <div className="stack-lg">
      <PageHeader title="Audit log" sub="Every booking, dispatch, refund, record view and settings change, with the staff member and time." />
      <form className="card form-grid three" onSubmit={(e) => { e.preventDefault(); setApplied(filters); }}>
        <TextField label="Action starts with" placeholder="booking, dispatch, refund..." value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} />
        <TextField label="From" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        <TextField label="To" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        <div><button className="btn btn-secondary">Filter</button></div>
      </form>
      {loading && <Loading />}
      {error && <Alert tone="error">{error.message}</Alert>}
      {data && data.entries.length === 0 && <Empty icon="inbox" title="No entries" />}
      {data && data.entries.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Details</th></tr></thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtShort(e.at)}</td>
                  <td><div className="strong">{e.staffName || 'System'}</div><div className="tiny muted">{ROLE_LABEL[e.staffRole] || e.staffRole || ''}</div></td>
                  <td className="mono small">{e.action}</td>
                  <td className="tiny mono">{e.targetType ? `${e.targetType} ${String(e.targetId || '').slice(0, 8)}` : '-'}</td>
                  <td className="tiny mono" style={{ maxWidth: 320, wordBreak: 'break-word' }}>{Object.keys(e.details || {}).length ? JSON.stringify(e.details) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Background jobs run every minute; Admin can run one now (for a demonstration or after a change). */
function Jobs() {
  const toast = useToast();
  const run = async (name, label) => {
    try {
      const r = await api.post(`/admin/jobs/${name}`);
      toast(`${label}: ${r.done} done`, 'success');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  return (
    <section className="card stack">
      <h3>Background jobs</h3>
      <p className="small muted">They run automatically. Each run is written to the audit log.</p>
      <div className="row">
        <button className="btn btn-subtle btn-sm" onClick={() => run('reminders', '24-hour reminders')}>Send 24-hour reminders</button>
        <button className="btn btn-subtle btn-sm" onClick={() => run('deliver', 'Message delivery')}>Deliver queued messages</button>
        <button className="btn btn-subtle btn-sm" onClick={() => run('expireHolds', 'Unpaid holds')}>Release unpaid holds</button>
        <button className="btn btn-subtle btn-sm" onClick={() => run('retention', 'Data retention (12 months)')}>Run data retention</button>
      </div>
    </section>
  );
}
