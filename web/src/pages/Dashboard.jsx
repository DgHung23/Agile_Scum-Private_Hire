import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Icon } from '../icons.jsx';
import { BookingCard } from '../components/BookingBits.jsx';
import { Empty, Loading, PageHeader, useLoad } from '../ui.jsx';
import { fmtDate } from '../format.js';

/** Customer home. Offers are added in Sprint 3. */
export default function Dashboard() {
  const { user } = useAuth();
  const { data, loading } = useLoad(() => api.get('/bookings?when=upcoming'));
  const offers = useLoad(() => api.get('/offers/mine'));
  const upcoming = data?.bookings.slice(0, 3) || [];
  return (
    <div className="container page">
      <div className="stack-lg">
        <PageHeader title={`Hello, ${user.fullName.split(' ')[0]}`} sub="Where are we taking you today?" />
        <div className="grid grid-3">
          <Link to="/book" className="card card-dark clickable stack-sm">
            <Icon name="car" size={28} />
            <h3>Book a minicab</h3>
            <p className="muted small">15% off, priced up front.</p>
          </Link>
          <Link to="/trips" className="card card-soft clickable stack-sm">
            <Icon name="calendar" size={28} />
            <h3>My trips</h3>
            <p className="muted small">Upcoming and past bookings, receipts and reviews.</p>
          </Link>
          <Link to="/messages" className="card card-soft clickable stack-sm">
            <Icon name="inbox" size={28} />
            <h3>Messages</h3>
            <p className="muted small">Confirmations and driver updates.</p>
          </Link>
        </div>

        {offers.data?.offers.length > 0 && (
          <section className="stack">
            <h3>Your offers</h3>
            <div className="grid grid-3">
              {offers.data.offers.map((o) => (
                <div key={o.id} className="card card-soft stack-sm">
                  <div className="row-between"><span className="badge black"><Icon name="gift" size={12} /> {o.discountPct}% off</span><span className="tiny">Until {fmtDate(o.expiresAt)}</span></div>
                  <div className="strong">{o.title}</div>
                  <div className="small muted">Code <span className="kbd">{o.code}</span> - enter it when you review your booking.</div>
                  <Link to="/book" className="btn btn-sm" style={{ alignSelf: 'flex-start' }}>Book now</Link>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="stack">
          <div className="row-between">
            <h3>Upcoming trips</h3>
            <Link to="/trips" className="small strong">See all</Link>
          </div>
          {loading && <Loading />}
          {data && upcoming.length === 0 && (
            <Empty icon="calendar" title="No trips booked" action={<Link to="/book" className="btn">Book your first ride</Link>} />
          )}
          <div className="grid grid-3">{upcoming.map((b) => <BookingCard key={b.id} b={b} />)}</div>
        </section>
      </div>
    </div>
  );
}
