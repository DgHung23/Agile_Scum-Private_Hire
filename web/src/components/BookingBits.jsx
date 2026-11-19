import { Link } from 'react-router-dom';
import { Icon } from '../icons.jsx';
import { ACCESSIBILITY_LABEL, CHANNEL_LABEL, fmtDate, fmtTime, money } from '../format.js';
import { Kv, StatusBadge } from '../ui.jsx';

/**
 * Price rows (ID-32): fare lines and surcharges, then the programme discount, then one coupon, then the total.
 * `price` = {full, surcharge, discountOnline, discountOffer, total, offerCode, lines}
 */
export function PriceBreakdown({ price, offerCode, discountPct = 15 }) {
  const lines = price.lines || [];
  return (
    <div>
      {lines.length > 0 ? (
        lines.map((l, i) => <Kv key={i} k={l.label} v={money(l.amount)} />)
      ) : (
        <Kv k="Full price" v={money(price.full)} />
      )}
      {lines.length > 1 && <Kv k="Full price" v={money(price.full)} />}
      {price.discountOnline > 0 && <Kv cls="discount" k={`Online discount (${discountPct}%)`} v={`-${money(price.discountOnline)}`} />}
      {price.discountOffer > 0 && <Kv cls="discount" k={`Coupon ${offerCode || price.offerCode || ''}`} v={`-${money(price.discountOffer)}`} />}
      <Kv cls="total" k="Total" v={money(price.total)} />
    </div>
  );
}

/** ID-30, ID-38, ID-39, ID-41, N15: the extras of a booking, as short lines. */
export function BookingExtras({ b }) {
  const items = [];
  if (b.luggage) items.push(`${b.luggage} bag${b.luggage === 1 ? '' : 's'}`);
  if (b.childSeatAges?.length) items.push(`${b.childSeatAges.length} child seat${b.childSeatAges.length === 1 ? '' : 's'} (age ${b.childSeatAges.join(', ')})`);
  if (b.pet) items.push('Travelling with a pet');
  for (const a of b.accessibility || []) items.push(`${ACCESSIBILITY_LABEL[a]} (no extra charge)`);
  if (b.passenger) items.push(`Passenger: ${b.passenger.name}, ${b.passenger.phone}`);
  if (b.flightNo) items.push(`Flight ${b.flightNo}`);
  if (b.noteToDriver) items.push(`Note to driver: ${b.noteToDriver}`);
  if (!items.length) return null;
  return (
    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
      {items.map((x) => <li key={x}>{x}</li>)}
    </ul>
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
