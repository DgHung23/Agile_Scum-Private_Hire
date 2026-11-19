import { useState } from 'react';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { fmtDate, money } from '../../format.js';
import { Alert, Empty, Loading, PageHeader, TextField, useLoad, useToast } from '../../ui.jsx';

const plusDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const TIER = { Gold: 'amber', Silver: '', Bronze: 'blue', New: '' };

/** US10.3: create an offer code with a percentage and expiry, and email it to selected customers. */
export default function StaffOffers() {
  const toast = useToast();
  const offers = useLoad(() => api.get('/staff/offers'));
  const loyal = useLoad(() => api.get('/staff/customers-loyalty?limit=50'));
  const [f, setF] = useState({ title: '', code: '', discountPct: 10, expiresOn: plusDays(30) });
  const [picked, setPicked] = useState(new Set());
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const toggle = (id) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setErrors({ ...errors, [k]: '' }); };

  const create = async (e) => {
    e.preventDefault();
    setError('');
    setErrors({});
    setBusy(true);
    try {
      const r = await api.post('/staff/offers', { ...f, code: f.code || undefined, discountPct: Number(f.discountPct), customerIds: [...picked] });
      toast(`Offer ${r.offer.code} emailed to ${r.sent} customer${r.sent === 1 ? '' : 's'}`, 'success');
      setF({ title: '', code: '', discountPct: 10, expiresOn: plusDays(30) });
      setPicked(new Set());
      offers.reload();
    } catch (err) {
      setErrors(err.fields || {});
      setError(err.fields?.customerIds || err.message);
    } finally {
      setBusy(false);
    }
  };

  const recommend = async () => {
    setBusy(true);
    try {
      const r = await api.post('/staff/offers/recommend', { discountPct: 10, validDays: 30, minTrips: 2 });
      toast(r.sent ? `Personal offers emailed to ${r.sent} repeat customer${r.sent === 1 ? '' : 's'}` : 'Everyone eligible already has a loyalty reward', r.sent ? 'success' : 'info');
      offers.reload();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const off = async (o) => {
    await api.post(`/staff/offers/${o.id}/deactivate`);
    toast(`${o.code} switched off`, 'success');
    offers.reload();
  };

  return (
    <div className="stack-lg">
      <PageHeader title="Special offers" sub="Reward loyal customers with a code. Customers enter it at checkout, on top of the 15% online discount."
        actions={<button className="btn btn-secondary" onClick={recommend} disabled={busy}><Icon name="gift" size={18} /> Send recommended offers</button>} />
      <p className="small muted" style={{ marginTop: -16 }}>
        "Recommended" gives every customer with 2 or more trips a personal 10% code for 30 days, mentioning the service they book most.
      </p>

      <form className="card stack" onSubmit={create} noValidate>
        <h3>New offer</h3>
        {error && <Alert tone="error">{error}</Alert>}
        <div className="form-grid two">
          <TextField className="span-2" label="Offer description" placeholder="e.g. 15% off your next airport transfer" value={f.title} onChange={set('title')} error={errors.title} />
          <TextField label="Discount (%)" type="number" min="1" max="50" value={f.discountPct} onChange={set('discountPct')} error={errors.discountPct} />
          <TextField label="Valid until" type="date" min={plusDays(0)} value={f.expiresOn} onChange={set('expiresOn')} error={errors.expiresOn} />
          <TextField label="Code (optional)" placeholder="Leave blank to generate" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} error={errors.code} hint="Letters and numbers, at least 4" />
        </div>

        <div className="stack-sm">
          <div className="row-between">
            <span className="label">Send to ({picked.size} selected)</span>
            <span className="row">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set((loyal.data?.customers || []).filter((c) => c.trips >= 1).map((c) => c.id)))}>Select customers with trips</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>Clear</button>
            </span>
          </div>
          {loyal.loading && <Loading />}
          <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="table">
              <thead><tr><th /><th>Customer</th><th>Tier</th><th>Trips</th><th>Spend</th><th>Books most</th></tr></thead>
              <tbody>
                {loyal.data?.customers.map((c) => (
                  <tr key={c.id}>
                    <td><input type="checkbox" aria-label={`Select ${c.fullName}`} checked={picked.has(c.id)} onChange={() => toggle(c.id)} style={{ width: 20, height: 20, accentColor: '#ff385c' }} /></td>
                    <td className="strong">{c.fullName}</td>
                    <td><span className={`badge ${TIER[c.tier]}`}>{c.tier}</span></td>
                    <td>{c.trips}</td>
                    <td>{money(c.spend)}</td>
                    <td>{c.favouriteService || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div><button className="btn btn-lg" disabled={busy}>{busy ? 'Sending...' : `Create offer and email ${picked.size || ''} customer${picked.size === 1 ? '' : 's'}`}</button></div>
      </form>

      <section className="stack">
        <h3>Offers sent</h3>
        {offers.loading && !offers.data && <Loading />}
        {offers.data?.offers.length === 0 && <Empty icon="gift" title="No offers yet" />}
        {offers.data?.offers.length > 0 && (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Code</th><th>Offer</th><th>Discount</th><th>Valid until</th><th>Sent to</th><th>Used</th><th /></tr></thead>
            <tbody>
              {offers.data.offers.map((o) => {
                const expired = new Date(o.expiresAt) < new Date();
                return (
                  <tr key={o.id}>
                    <td className="mono strong">{o.code}</td>
                    <td>{o.title}</td>
                    <td>{o.discountPct}%</td>
                    <td>{fmtDate(o.expiresAt)} {expired && <span className="badge">Expired</span>}{!o.active && <span className="badge red">Off</span>}</td>
                    <td>{o.recipients}</td>
                    <td>{o.redemptions}</td>
                    <td>{o.active && !expired && <button className="btn btn-ghost btn-sm" onClick={() => off(o)}>Switch off</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
