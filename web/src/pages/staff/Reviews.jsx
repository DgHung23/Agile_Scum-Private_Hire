import { useState } from 'react';
import { api, qs } from '../../api.js';
import { fmtDate } from '../../format.js';
import { Alert, Empty, Loading, PageHeader, Stars, useLoad } from '../../ui.jsx';

/** US7.2: reviews with average ratings by driver and by car, so service problems can be spotted. */
export default function StaffReviews() {
  const [low, setLow] = useState(false);
  const sum = useLoad(() => api.get('/staff/reviews/summary'));
  const list = useLoad(() => api.get('/staff/reviews' + qs({ maxRating: low ? 2 : undefined })), [low]);

  return (
    <div className="stack-lg">
      <PageHeader title="Reviews" sub="What customers say about journeys, cars and drivers." />
      {sum.loading && <Loading />}
      {sum.error && <Alert tone="error">{sum.error.message}</Alert>}
      {sum.data && (
        <>
          <div className="grid grid-4">
            {[['Reviews', sum.data.overall.reviews], ['Journey', sum.data.overall.journey], ['Minicab', sum.data.overall.cab], ['Driver', sum.data.overall.driver]].map(([l, n]) => (
              <div key={l} className="stat"><div className="n">{n ?? '-'}</div><div className="l">{l === 'Reviews' ? 'Total reviews' : `${l} average (of 5)`}</div></div>
            ))}
          </div>
          <div className="grid grid-2" style={{ alignItems: 'start' }}>
            <section className="stack">
              <h3>By driver</h3>
              {sum.data.drivers.length === 0 && <Empty icon="star" title="No driver reviews yet" />}
              {sum.data.drivers.length > 0 && (
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>Driver</th><th>Rating</th><th>Reviews</th></tr></thead>
                  <tbody>{sum.data.drivers.map((d) => (
                    <tr key={d.id}><td className="strong">{d.name} {d.needsAttention && <span className="badge red">Needs attention</span>}</td><td><Stars value={d.rating} size={16} /> <span className="mono small">{d.rating}</span></td><td>{d.reviews}</td></tr>
                  ))}</tbody>
                </table></div>
              )}
            </section>
            <section className="stack">
              <h3>By car</h3>
              {sum.data.cabs.length === 0 && <Empty icon="car" title="No car reviews yet" />}
              {sum.data.cabs.length > 0 && (
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>Car</th><th>Rating</th><th>Reviews</th></tr></thead>
                  <tbody>{sum.data.cabs.map((c) => (
                    <tr key={c.id}><td><span className="mono strong">{c.reg}</span> {c.name} {c.needsAttention && <span className="badge red">Needs attention</span>}</td><td><Stars value={c.rating} size={16} /> <span className="mono small">{c.rating}</span></td><td>{c.reviews}</td></tr>
                  ))}</tbody>
                </table></div>
              )}
            </section>
          </div>
        </>
      )}

      <section className="stack">
        <div className="row-between">
          <h3>All reviews</h3>
          <div className="chips">
            <button className={`chip ${!low ? 'active' : ''}`} onClick={() => setLow(false)}>All</button>
            <button className={`chip ${low ? 'active' : ''}`} onClick={() => setLow(true)}>Low scores (2 or less)</button>
          </div>
        </div>
        {list.loading && !list.data && <Loading />}
        {list.data?.reviews.length === 0 && <Empty icon="star" title="No reviews to show" />}
        {list.data?.reviews.map((r) => (
          <article key={r.id} className="card stack-sm">
            <div className="row-between"><span className="strong">{r.route}</span><span className="tiny mono">{r.bookingRef} &middot; {fmtDate(r.createdAt)}</span></div>
            <div className="row" style={{ gap: 24 }}>
              <span className="small">Journey <Stars value={r.journeyRating} size={14} /></span>
              <span className="small">Cab <Stars value={r.cabRating} size={14} /> {r.cab}</span>
              <span className="small">Driver <Stars value={r.driverRating} size={14} /> {r.driverName}</span>
            </div>
            {r.comment && <p className="small muted">&ldquo;{r.comment}&rdquo; - {r.customerName}</p>}
          </article>
        ))}
      </section>
    </div>
  );
}
