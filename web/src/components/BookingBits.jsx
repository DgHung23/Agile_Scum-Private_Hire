import { Link } from 'react-router-dom';
import { Icon } from '../icons.jsx';
import { CHANNEL_LABEL, fmtDate, fmtTime, money } from '../format.js';
import { Kv, StatusBadge } from '../ui.jsx';

/** Price rows: full price, discounts, total (US3.4 criterion 1). `price` = {full, discountOnline, discountOffer, total, offerCode} */
export function PriceBreakdown({ price, offerCode, discountPct = 15 }) {
  return (
    <div>
      <Kv k="Full price" v={money(price.full)} />
      {price.discountOnline > 0 && <Kv cls="discount" k={`Online discount (${discountPct}%)`} v={`-${money(price.discountOnline)}`} />}
      {price.discountOffer > 0 && <Kv cls="discount" k={`Offer ${offerCode || price.offerCode || ''}`} v={`-${money(price.discountOffer)}`} />}
      <Kv cls="total" k="Total" v={money(price.total)} />
    </div>
  );
}

export function RouteLine({ pickup, destination }) {
  return (
    <div className="stack-sm" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <Icon name="pin" size={18} />
        <span>{pickup}</span>
      </div>
      <div className="row" style={{ gap: 10, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <Icon name="arrow" size={18} />
        <span>{destination}</span>
      </div>
    </div>
  );
}

export function BookingCard({ b, to }) {
  return (
    <Link to={to || `/trips/${b.id}`} className="card clickable stack-sm">
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="strong">{fmtDate(b.pickupAt)}</div>
          <div className="muted small">{fmtTime(b.pickupAt)} &middot; {b.service.label}</div>
        </div>
        <StatusBadge status={b.status} />
      </div>
      <RouteLine pickup={b.pickup} destination={b.destination} />
      <div className="row-between small">
        <span className="muted mono">{b.ref}{b.channel !== 'online' ? ` · ${CHANNEL_LABEL[b.channel]}` : ''}</span>
        <span className="strong">{money(b.price.total)}</span>
      </div>
    </Link>
  );
}
