import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { fmtDate, fmtDateTime, money } from '../format.js';
import { Alert, Kv, Loading, useLoad } from '../ui.jsx';

/** US6.1: printable receipt. The Print button opens the browser print view; chrome is hidden by print CSS. */
export function ReceiptView({ r, backTo }) {
  return (
    <div className="stack-lg">
      <div className="row-between no-print">
        {backTo ? <Link to={backTo} className="small strong">&larr; Back to booking</Link> : <span />}
        <button className="btn" onClick={() => window.print()}><Icon name="printer" size={18} /> Print receipt</button>
      </div>
      <article className="receipt stack-lg" aria-label="Receipt">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div>
            <img src="/brand/logo.svg" alt={r.company.name} className="brand-logo" width="158" height="28" style={{ marginBottom: 10 }} />
            <div className="small muted">{r.company.address}<br />{r.company.phone} &middot; {r.company.email}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <h2 style={{ fontSize: 28 }}>Receipt</h2>
            <div className="mono small">{r.receiptNo}</div>
            <div className="small muted">Issued {fmtDate(r.issuedAt)}</div>
          </div>
        </div>

        <div className="grid grid-2">
          <div className="stack-sm">
            <div className="label">Billed to</div>
            <div>{r.customer.name}</div>
            <div className="small muted">{r.customer.email}<br />{r.customer.address}</div>
          </div>
          <div className="stack-sm">
            <div className="label">Booking reference</div>
            <div className="mono strong" style={{ fontSize: 20 }}>{r.booking.ref}</div>
            <div className="small muted">{r.booking.status === 'cancelled' ? 'Cancelled booking' : r.booking.service}</div>
          </div>
        </div>

        <div className="stack-sm">
          <div className="label">Journey</div>
          <Kv k="Pickup" v={r.booking.pickup} />
          <Kv k="Destination" v={r.booking.destination} />
          <Kv k="Date and time" v={fmtDateTime(r.booking.pickupAt)} />
          <Kv k="Passengers" v={r.booking.passengers} />
          <Kv k="Cab" v={r.booking.size} />
          {r.booking.hours && <Kv k="Hire length" v={`${r.booking.hours} hours`} />}
        </div>

        <div className="stack-sm">
          <div className="label">Charges</div>
          <Kv k="Journey price" v={money(r.price.full)} />
          {r.price.discountOnline > 0 && <Kv cls="discount" k="Online booking discount (15%)" v={`-${money(r.price.discountOnline)}`} />}
          {r.price.discountOffer > 0 && <Kv cls="discount" k={`Offer code ${r.price.offerCode}`} v={`-${money(r.price.discountOffer)}`} />}
          <Kv cls="total" k="Final cost" v={money(r.price.total)} />
        </div>

        <div className="stack-sm">
          <div className="label">Payments</div>
          {r.payments.length === 0 && <p className="small muted">No payment recorded.</p>}
          {r.payments.map((p) => (
            <Kv key={p.id} k={`${p.kind === 'refund' ? 'Refund' : 'Paid'} - ${p.description} - ${fmtDate(p.createdAt)}`} v={`${p.kind === 'refund' ? '-' : ''}${money(p.amount)}`} />
          ))}
          <Kv cls="total" k="Net paid" v={money(r.netPaid)} />
        </div>
        <p className="tiny">Thank you for travelling with Private Hire Cars. Keep this receipt for your records.</p>
      </article>
    </div>
  );
}

export default function Receipt() {
  const { id } = useParams();
  const { data, loading, error } = useLoad(() => api.get(`/bookings/${id}/receipt`), [id]);
  return (
    <div className="container page">
      {loading && <Loading />}
      {error && <Alert tone="error">{error.message}</Alert>}
      {data && <ReceiptView r={data.receipt} backTo={`/trips/${id}`} />}
    </div>
  );
}
