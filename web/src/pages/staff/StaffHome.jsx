import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import { api, qs } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { fmtShort, money } from '../../format.js';
import { Alert, Empty, Loading, PageHeader, StatusBadge, useLoad, useToast } from '../../ui.jsx';
import { MessageCard } from '../Messages.jsx';

function Stat({ n, label, to, tone }) {
  const body = (
    <div className="stat" style={tone === 'alert' && n > 0 ? { background: 'var(--warn-bg)' } : undefined}>
      <div className="n">{n}</div>
      <div className="l">{label}</div>
    </div>
  );
  return to ? <Link to={to} style={{ textDecoration: 'none' }}>{body}</Link> : body;
}

export default function StaffHome() {
  const { user } = useAuth();
  const { data, loading, error } = useLoad(() => api.get('/staff/dashboard'));
  return (
    <div className="stack-lg">
      <PageHeader title={`Welcome, ${user.fullName.split(' ')[0]}`} sub={user.role === 'manager' ? 'Manager view' : 'Call Centre view'}
        actions={<><Link to="/staff/call-desk" className="btn"><Icon name="headset" size={18} /> Call desk</Link><Link to="/staff/dispatch" className="btn btn-subtle">Dispatch</Link></>} />
      {loading && <Loading />}
      {error && <Alert tone="error">{error.message}</Alert>}
      {data && (
        <>
          <div className="grid grid-4">
            <Stat n={data.stats.today} label="Journeys today" to="/staff/dispatch" />
            <Stat n={data.stats.needsDriver} label="Need a driver" to="/staff/dispatch" tone="alert" />
            <Stat n={data.stats.onRoute} label="On route now" to="/staff/dispatch" />
            <Stat n={data.stats.newEnquiries} label="New enquiries" to="/staff/enquiries" tone="alert" />
          </div>
          {(data.stats.openIncidents > 0 || data.stats.failedMessages > 0) && <Alerts stats={data.stats} />}
          {user.role === 'manager' && <Channels />}
          <section className="stack">
            <div className="row-between">
              <h3>Next up</h3>
              <span className="small muted">{data.stats.priorityOpen} priority online booking{data.stats.priorityOpen === 1 ? '' : 's'} open</span>
            </div>
            {data.next.length === 0 && <Empty icon="calendar" title="Nothing coming up" />}
            <div className="table-wrap">
              {data.next.length > 0 && (
                <table className="table">
                  <thead><tr><th>Pickup</th><th>Journey</th><th>Customer</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {data.next.map((b) => (
                      <tr key={b.id}>
                        <td className="strong" style={{ whiteSpace: 'nowrap' }}>{fmtShort(b.pickupAt)}</td>
                        <td>{b.pickup} &rarr; {b.destination}<div className="tiny mono">{b.ref}</div></td>
                        <td>{b.customer.name}</td>
                        <td><StatusBadge status={b.status} /></td>
                        <td>{b.priority && <span className="badge black"><Icon name="zap" size={12} /> Priority</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** N20, N22 open incidents first; ID-44 messages that failed after 3 tries. */
function Alerts({ stats }) {
  const toast = useToast();
  const { data, reload } = useLoad(() => api.get('/staff/incidents'));
  const open = (data?.incidents || []).filter((i) => i.status === 'open');
  const handle = async (i) => {
    await api.post(`/staff/incidents/${i.id}/handle`);
    toast('Marked as handled', 'success');
    reload();
  };
  return (
    <section className="stack">
      {open.map((i) => (
        <Alert key={i.id} tone={i.kind === 'emergency' ? 'error' : 'warn'} icon="alert">
          <div className="row-between" style={{ gap: 12, flexWrap: 'wrap' }}>
            <span>
              <strong>{i.kind === 'emergency' ? 'EMERGENCY' : 'Problem with journey'}</strong> on <span className="mono">{i.booking.ref}</span>
              {i.reporter && <> - {i.reporter.name}, <a href={`tel:${i.reporter.phone}`}>{i.reporter.phone}</a></>}
              {i.message && <> - "{i.message}"</>} ({fmtShort(i.createdAt)})
            </span>
            <button className="btn btn-sm btn-secondary" onClick={() => handle(i)}>Mark handled</button>
          </div>
        </Alert>
      ))}
      {stats.failedMessages > 0 && (
        <Alert tone="warn">
          {stats.failedMessages} message{stats.failedMessages === 1 ? '' : 's'} could not be delivered after 3 tries this week.{' '}
          <Link to="/staff/outbox?status=failed" className="strong">See failed messages</Link>
        </Alert>
      )}
    </section>
  );
}

export function StaffOutbox() {
  const [params] = useSearchParams();
  const status = params.get('status') || '';
  const { data, loading, error } = useLoad(() => api.get('/notifications' + qs({ scope: 'all', limit: 100, status })), [status]);
  return (
    <div className="stack-lg">
      <PageHeader title="Outbox" sub="Every email and text message sent by the system, with its delivery result."
        actions={<div className="chips">
          <Link to="/staff/outbox" className={`chip ${!status ? 'active' : ''}`}>All</Link>
          <Link to="/staff/outbox?status=failed" className={`chip ${status === 'failed' ? 'active' : ''}`}>Failed</Link>
        </div>} />
      {loading && <Loading />}
      {error && <Alert tone="error">{error.message}</Alert>}
      {data && data.notifications.length === 0 && <Empty title="Nothing sent yet" />}
      <div className="stack">
        {data?.notifications.map((n) => <MessageCard key={n.id} n={n} showRecipient />)}
      </div>
    </div>
  );
}

const CHANNEL = { online: 'Online', phone: 'Phone', in_person: 'In person' };

/** N32: bookings by channel against the Board's objective of 40% online (report Table 4). */
function Channels() {
  const [days, setDays] = useState(30);
  const { data } = useLoad(() => api.get(`/staff/reports/popular?days=${days}`), [days]);
  if (!data) return null;
  const total = data.totals.bookings || 1;
  const online = data.byChannel.find((c) => c.channel === 'online')?.bookings || 0;
  const share = Math.round((online / total) * 100);
  return (
    <section className="card stack">
      <div className="row-between">
        <h3>Bookings by channel</h3>
        <div className="chips">{[7, 30, 90].map((d) => <button key={d} className={`chip ${days === d ? 'active' : ''}`} onClick={() => setDays(d)}>{d} days</button>)}</div>
      </div>
      <p className="small">Online share: <strong>{share}%</strong> of {data.totals.bookings} bookings (Board target: 40%). Revenue {money(data.totals.revenue)}.</p>
      {data.byChannel.map((c) => (
        <div key={c.channel} className="stack-sm">
          <div className="row-between small"><span>{CHANNEL[c.channel] || c.channel}</span><span>{c.bookings} &middot; {money(c.revenue)}</span></div>
          <div style={{ height: 8, background: 'var(--soft)', borderRadius: 999 }} aria-hidden="true">
            <div style={{ width: `${Math.round((c.bookings / total) * 100)}%`, height: '100%', borderRadius: 999, background: c.channel === 'online' ? 'var(--primary)' : 'var(--ink)' }} />
          </div>
        </div>
      ))}
    </section>
  );
}
