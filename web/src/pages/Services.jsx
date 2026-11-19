import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { money } from '../format.js';
import { Alert, Loading, useLoad } from '../ui.jsx';
import { SERVICE_ICONS } from './Home.jsx';

export default function Services() {
  const { data, loading, error } = useLoad(() => api.publicGet('/catalog/services'));
  const sizes = useLoad(() => api.publicGet('/catalog/cab-sizes'));
  return (
    <div className="container page">
      <div className="stack-lg">
        <div className="stack-sm">
          <h1 style={{ fontSize: 'clamp(30px,4vw,44px)' }}>Our services</h1>
          <p className="muted" style={{ fontSize: 18, maxWidth: 640 }}>
            From a quick local hop to a full day with your own driver. Book online and every journey is 15% cheaper.
          </p>
        </div>
        {loading && <Loading />}
        {error && <Alert tone="error">{error.message}</Alert>}
        <div className="grid grid-3">
          {data?.services.map((s) => (
            <div key={s.code} className="card card-soft stack">
              <Icon name={SERVICE_ICONS[s.code] || 'car'} size={28} />
              <h3>{s.label}</h3>
              <p className="muted small">{s.description}</p>
              <p className="strong">
                {s.isHourly ? `From ${money(s.hourlyRate * s.minHours)} (${s.minHours} hours minimum)` : `From ${money(s.minFare)}`}
              </p>
              <Link to={`/book?service=${s.code}`} className="btn btn-sm" style={{ alignSelf: 'flex-start' }}>Book this</Link>
            </div>
          ))}
        </div>
        {sizes.data && (
          <section className="stack">
            <h2>Choose the right cab</h2>
            <div className="chips">
              {sizes.data.cabSizes.map((s) => <span key={s.code} className="chip" style={{ cursor: 'default' }}><Icon name="users" size={16} /> {s.label}</span>)}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
