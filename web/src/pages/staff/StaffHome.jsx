import { Link } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import { api, qs } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { fmtShort } from '../../format.js';
import { Alert, Empty, Loading, PageHeader, StatusBadge, useLoad } from '../../ui.jsx';
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
      <PageHeader title={`Welcome, ${user.fullName.split(' ')[0]}`} sub={user.role === 'admin' ? 'Manager view' : 'Call-centre view'}
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

export function StaffOutbox() {
  const { data, loading, error } = useLoad(() => api.get('/notifications' + qs({ scope: 'all', limit: 100 })));
  return (
    <div className="stack-lg">
      <PageHeader title="Outbox" sub="Every simulated email and text message sent by the system." />
      {loading && <Loading />}
      {error && <Alert tone="error">{error.message}</Alert>}
      {data && data.notifications.length === 0 && <Empty title="Nothing sent yet" />}
      <div className="stack">
        {data?.notifications.map((n) => <MessageCard key={n.id} n={n} showRecipient />)}
      </div>
    </div>
  );
}
