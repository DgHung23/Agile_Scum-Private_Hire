import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { fmtDateTime, fmtShort, londonParts, londonToIso, money, todayLondon } from '../format.js';
import { Alert, Kv, Loading, SelectField, TextField, useLoad, useToast } from '../ui.jsx';

/** US8.2: change time, date, addresses, passengers or cab size. Shows availability and the price difference before saving. */
export default function Amend() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const booking = useLoad(() => api.get(`/bookings/${id}`), [id]);
  const sizes = useLoad(() => api.publicGet('/catalog/cab-sizes'));
  const places = useLoad(() => api.publicGet('/catalog/locations?limit=50'));
  const packages = useLoad(() => api.publicGet('/catalog/packages'));
  const [f, setF] = useState(null);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [alt, setAlt] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const b = booking.data?.booking;
  useEffect(() => {
    if (b && !f) {
      const { date, time } = londonParts(b.pickupAt);
      setF({ pickup: b.pickup, destination: b.destination, date, time, passengers: b.passengers, luggage: b.luggage || 0, hours: b.hours || '', packageCode: b.package?.code || '', sizeCode: b.size.code });
    }
  }, [b, f]);

  if (booking.loading || !f) return <div className="container page"><Loading /></div>;
  if (booking.error) return <div className="container page"><Alert tone="error">{booking.error.message}</Alert></div>;
  const hourly = !!b.hours;

  const set = (k, v) => {
    setF((s) => ({ ...s, [k]: v }));
    setPreview(null);
    setAlt(null);
    setErrors((e) => ({ ...e, [k]: '' }));
  };

  const body = () => ({
    pickup: f.pickup,
    destination: hourly ? '' : f.destination,
    pickupAt: londonToIso(f.date, f.time) || '',
    passengers: Number(f.passengers),
    luggage: Number(f.luggage) || 0,
    ...(f.packageCode ? { packageCode: f.packageCode } : {}),
    sizeCode: f.sizeCode,
    ...(hourly ? { hours: Number(f.hours) } : {}),
  });

  const check = async (e) => {
    e.preventDefault();
    setError('');
    setErrors({});
    setAlt(null);
    setBusy(true);
    try {
      const p = await api.post(`/bookings/${id}/amend/preview`, body());
      setPreview(p);
      if (!p.available) {
        setAlt(p.alternatives);
        setError('That cab is not free at the new time. Choose another time or cab size.');
      }
    } catch (err) {
      setError(err.message);
      setErrors({ ...err.fields, date: err.fields?.pickupAt });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post(`/bookings/${id}/amend`, body());
      toast(
        r.difference > 0 ? `Booking updated. ${money(r.difference)} charged to your original payment method.` : r.difference < 0 ? `Booking updated. ${money(Math.abs(r.difference))} refunded.` : 'Booking updated.',
        'success',
      );
      nav(`/trips/${id}`, { replace: true });
    } catch (err) {
      setError(err.message);
      if (err.alternatives) setAlt(err.alternatives);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const takeTime = (iso) => {
    const { date, time } = londonParts(iso);
    setF((s) => ({ ...s, date, time }));
    setPreview(null);
    setAlt(null);
    setError('');
  };

  return (
    <div className="container page">
      <div className="medium stack-lg">
        <div><Link to={`/trips/${id}`} className="small strong">&larr; Back to booking {b.ref}</Link></div>
        <div>
          <h2>Change your booking</h2>
          <p className="muted" style={{ marginTop: 6 }}>
            {b.service.label} &middot; the service type cannot be changed. You can change this until {fmtDateTime(b.cancelDeadline)}.
          </p>
        </div>

        {error && <Alert tone="error">{error}</Alert>}
        {alt && (
          <div className="card card-soft stack">
            {alt.sizes?.length > 0 && (
              <div className="stack-sm">
                <div className="strong">Available at this time in another size</div>
                <div className="chips">{alt.sizes.map((s) => <button key={s.code} className="chip" onClick={() => set('sizeCode', s.code)}>{s.label}</button>)}</div>
              </div>
            )}
            {alt.times?.length > 0 && (
              <div className="stack-sm">
                <div className="strong">Or a nearby time</div>
                <div className="chips">{alt.times.map((t) => <button key={t} className="chip" onClick={() => takeTime(t)}>{fmtShort(t)}</button>)}</div>
              </div>
            )}
          </div>
        )}

        <form className="card stack" onSubmit={check} noValidate>
          <datalist id="places">{(places.data?.locations || []).map((l) => <option key={l.name} value={l.name} />)}</datalist>
          <div className="form-grid two">
            <TextField className="span-2" label="Pickup location" list="places" value={f.pickup} onChange={(e) => set('pickup', e.target.value)} error={errors.pickup} />
            {!hourly && <TextField className="span-2" label="Destination" list="places" value={f.destination} onChange={(e) => set('destination', e.target.value)} error={errors.destination} />}
            <TextField label="Date" type="date" min={todayLondon()} value={f.date} onChange={(e) => set('date', e.target.value)} error={errors.date} />
            <TextField label="Pickup time" type="time" step="300" value={f.time} onChange={(e) => set('time', e.target.value)} error={errors.time} />
            <TextField label="Passengers" type="number" min="1" max="8" value={f.passengers} onChange={(e) => set('passengers', e.target.value)} error={errors.passengers} />
            <TextField label="Bags" type="number" min="0" max="12" value={f.luggage} onChange={(e) => set('luggage', e.target.value)} error={errors.luggage} />
            {hourly && f.packageCode && (
              <SelectField label="Package" value={f.packageCode} onChange={(e) => set('packageCode', e.target.value)} error={errors.packageCode}>
                {(packages.data?.packages || []).map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
              </SelectField>
            )}
            {hourly && !f.packageCode && <TextField label="Hours" type="number" min="4" max="12" value={f.hours} onChange={(e) => set('hours', e.target.value)} error={errors.hours} />}
            <SelectField className="span-2" label="Cab size" value={f.sizeCode} onChange={(e) => set('sizeCode', e.target.value)} error={errors.sizeCode}>
              {(sizes.data?.cabSizes || []).map((s) => <option key={s.code} value={s.code} disabled={s.seats < Number(f.passengers)}>{s.label}</option>)}
            </SelectField>
          </div>
          <div><button className="btn btn-lg" disabled={busy}>{busy && !preview ? 'Checking...' : 'Check changes and price'}</button></div>
        </form>

        {preview?.available && (
          <section className="card card-elevated stack" aria-live="polite">
            <h3>What changes</h3>
            <Kv k="Current total" v={money(preview.oldTotal)} />
            <Kv k="New total" v={money(preview.newTotal)} />
            <Kv cls="total" k={preview.difference > 0 ? 'You pay extra' : preview.difference < 0 ? 'You get back' : 'Difference'} v={money(Math.abs(preview.difference))} />
            <p className="small muted">
              {preview.difference > 0 && 'The extra amount is charged to the payment method you used for this booking.'}
              {preview.difference < 0 && 'The difference is refunded to the payment method you used for this booking.'}
              {preview.difference === 0 && 'The price stays the same.'}
              {' '}A cab is available at the new time.
            </p>
            <button className="btn btn-lg btn-block" onClick={save} disabled={busy}>{busy ? 'Saving...' : 'Confirm changes'}</button>
          </section>
        )}
      </div>
    </div>
  );
}
