import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Icon } from '../icons.jsx';
import { PageHeader } from '../ui.jsx';

/** Customer home. Sections are filled in as modules are delivered (upcoming trips in Sprint 2, offers in Sprint 3). */
export default function Dashboard() {
  const { user } = useAuth();
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
      </div>
    </div>
  );
}
