import { useAuth } from '../../auth.jsx';
import { api, qs } from '../../api.js';
import { Alert, Empty, Loading, PageHeader, useLoad } from '../../ui.jsx';
import { MessageCard } from '../Messages.jsx';

export default function StaffHome() {
  const { user } = useAuth();
  return (
    <div className="stack-lg">
      <PageHeader title={`Welcome, ${user.fullName.split(' ')[0]}`} sub={user.role === 'admin' ? 'Manager view' : 'Call-centre view'} />
      <Alert tone="info">
        Dashboards, the call desk, fleet and dispatch screens arrive in later sprints. Use the Outbox to see every
        email and text the system has sent.
      </Alert>
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
