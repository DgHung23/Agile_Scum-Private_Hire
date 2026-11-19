import { useState } from 'react';
import { api } from '../../api.js';
import { CHANNEL_LABEL, fmtDate, money } from '../../format.js';
import { Alert, Empty, Loading, PageHeader, SelectField, useLoad } from '../../ui.jsx';

/** Horizontal bar list: label, bar scaled to the max, value. Plain HTML so it works everywhere and prints. */
function Bars({ rows, label, value, format = (v) => v, unit }) {
  const max = Math.max(1, ...rows.map((r) => r[value]));
  return (
    <div className="stack-sm" role="list">
      {rows.map((r) => (
        <div key={label(r)} role="listitem" style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 160px) 1fr auto', gap: 10, alignItems: 'center' }}>
          <span className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label(r)}>{label(r)}</span>
          <div style={{ background: 'var(--soft)', borderRadius: 999, height: 14 }}>
            <div style={{ width: `${(r[value] / max) * 100}%`, background: 'var(--primary)', height: '100%', borderRadius: 999, minWidth: r[value] ? 6 : 0 }} />
          </div>
          <span className="small strong mono" style={{ minWidth: 64, textAlign: 'right' }}>{format(r[value])}{unit || ''}</span>
        </div>
      ))}
    </div>
  );
}

const TIER = { Gold: 'amber', Silver: '', Bronze: 'blue', New: '' };

/** US10.1 popular cars and sizes, US10.2 loyal customers. Manager (admin) only. */
export default function StaffReports() {
  const [days, setDays] = useState(90);
  const pop = useLoad(() => api.get(`/staff/reports/popular?days=${days}`), [days]);
  const loyal = useLoad(() => api.get('/staff/customers-loyalty?minTrips=1&limit=20'));
  const p = pop.data;

  return (
    <div className="stack-lg">
      <PageHeader title="Reports" sub="Which cars are in demand and who your most loyal customers are."
        actions={
          <SelectField label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last 12 months</option>
          </SelectField>
        } />
      {pop.loading && !p && <Loading />}
      {pop.error && <Alert tone="error">{pop.error.message}</Alert>}
      {p && (
        <>
          <div className="grid grid-3">
            <div className="stat"><div className="n">{p.totals.bookings}</div><div className="l">Bookings (not cancelled)</div></div>
            <div className="stat"><div className="n">{money(p.totals.revenue)}</div><div className="l">Booking value</div></div>
            <div className="stat"><div className="n">{p.byChannel.find((c) => c.channel === 'online')?.bookings ?? 0}</div><div className="l">Booked online (15% discount, priority)</div></div>
          </div>
          {p.totals.bookings === 0 && <Empty icon="chart" title="No bookings in this period" />}
          {p.totals.bookings > 0 && (
            <div className="grid grid-2" style={{ alignItems: 'start' }}>
              <section className="card stack"><h3>Most-booked cabs</h3>
                <Bars rows={p.topCabs} label={(r) => `${r.reg} ${r.make} ${r.model}`} value="bookings" /></section>
              <section className="card stack"><h3>Popular car models</h3>
                <Bars rows={p.topModels} label={(r) => `${r.make} ${r.model}`} value="bookings" /></section>
              <section className="card stack"><h3>Bookings by cab size</h3>
                <Bars rows={p.bySize} label={(r) => r.size} value="bookings" /></section>
              <section className="card stack"><h3>Bookings by service</h3>
                <Bars rows={p.byService} label={(r) => r.service} value="bookings" /></section>
              <section className="card stack"><h3>Booking channel</h3>
                <Bars rows={p.byChannel} label={(r) => CHANNEL_LABEL[r.channel]} value="bookings" /></section>
            </div>
          )}
        </>
      )}

      <section className="stack">
        <h3>Most loyal customers</h3>
        {loyal.loading && <Loading />}
        {loyal.data?.customers.length === 0 && <Empty icon="users" title="No bookings yet" />}
        {loyal.data?.customers.length > 0 && (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>#</th><th>Customer</th><th>Tier</th><th>Trips</th><th>Total spend</th><th>Books most</th><th>Last trip</th></tr></thead>
            <tbody>
              {loyal.data.customers.map((c, i) => (
                <tr key={c.id}>
                  <td>{i + 1}</td>
                  <td className="strong">{c.fullName}</td>
                  <td><span className={`badge ${TIER[c.tier]}`}>{c.tier}</span></td>
                  <td>{c.trips}</td>
                  <td>{money(c.spend)}</td>
                  <td>{c.favouriteService || '-'} {c.favouriteSize && <span className="muted small">({c.favouriteSize})</span>}</td>
                  <td>{c.lastTrip ? fmtDate(c.lastTrip) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        <p className="tiny">Tiers: Bronze 2+ trips, Silver 5+, Gold 10+. Send rewards from Offers.</p>
      </section>
    </div>
  );
}
