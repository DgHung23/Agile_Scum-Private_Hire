import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import { fmtDateTime } from '../format.js';
import { Alert, Kv, Loading, StatusBadge, useLoad } from '../ui.jsx';

/** N21: a shared trip, opened from a private link. Shows the car and driver first name only - no personal data. */
export default function Track() {
  const { token } = useParams();
  const { data, loading, error } = useLoad(() => api.publicGet(`/track/${token}`), [token]);
  if (loading) return <div className="container page"><Loading /></div>;
  if (error) return <div className="container page"><div className="narrow"><Alert tone="error">{error.message}</Alert></div></div>;
  const t = data.trip;
  return (
    <div className="container page">
      <div className="narrow stack-lg">
        <div>
          <h2>{t.sharedBy}'s journey</h2>
          <p className="muted" style={{ marginTop: 6 }}>Shared with you through Private Hire Cars.</p>
        </div>
        <section className="card stack">
          <div className="row-between"><h3>Status</h3><StatusBadge status={t.status} /></div>
          <Kv k="Pickup time" v={fmtDateTime(t.pickupAt)} />
          <Kv k="From" v={t.pickupArea} />
          <Kv k="To" v={t.destination} />
          {t.etaMinutes != null && <Kv k="Driver arriving in" v={`about ${t.etaMinutes} minutes`} />}
        </section>
        {t.vehicle && (
          <section className="card card-dark stack">
            <h3>The car</h3>
            <div className="mono strong" style={{ fontSize: 24 }}>{t.vehicle.reg}</div>
            <div>{t.vehicle.colour} {t.vehicle.make} {t.vehicle.model}{t.driverFirstName ? `, driven by ${t.driverFirstName}` : ''}</div>
          </section>
        )}
        <p className="tiny">In an emergency call 999. To reach Private Hire Cars call 020 7000 0000.</p>
      </div>
    </div>
  );
}
