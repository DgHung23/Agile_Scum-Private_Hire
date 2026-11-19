import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { Icon } from '../../icons.jsx';
import { ACCESSIBILITY_LABEL, fmtDateTime, fmtShort, londonParts, londonToIso, money, todayLondon } from '../../format.js';
import { Alert, Kv, Loading, SelectField, TextField, useLoad } from '../../ui.jsx';
import CardForm, { BLANK_CARD } from '../../components/CardForm.jsx';
import { onlyDigits, parseExpiry, validateCardForm } from '../../validators.js';
import { BookingExtras, PriceBreakdown } from '../../components/BookingBits.jsx';

/** ID-35, ID-36: book for a verified phone or walk-in customer and record payment. Same checks as online; no online discount (R3). */
export default function StaffBook() {
  const { id } = useParams();
  const customer = useLoad(() => api.get(`/staff/customers/${id}`), [id]);
  const services = useLoad(() => api.publicGet('/catalog/services'));
  const places = useLoad(() => api.publicGet('/catalog/locations?limit=50'));
  const packages = useLoad(() => api.publicGet('/catalog/packages'));

  const [f, setF] = useState({ channel: 'phone', serviceCode: 'local', pickup: '', destination: '', date: '', time: '', passengers: 1, luggage: 0, packageCode: 'half_day', sizeCode: '', notifyPref: 'email', accessibility: [], childSeats: 0, pet: false, flightNo: '', noteToDriver: '', passengerName: '', passengerPhone: '' });
  const [quote, setQuote] = useState(null);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [alt, setAlt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pay, setPay] = useState('driver'); // driver | cash | card
  const [card, setCard] = useState(BLANK_CARD);
  const [cardErrors, setCardErrors] = useState({});
  const [done, setDone] = useState(null);

  useEffect(() => {
    if (customer.data) setF((s) => ({ ...s, notifyPref: customer.data.customer.notifyPref }));
  }, [customer.data]);

  if (customer.loading || services.loading) return <Loading />;
  if (customer.error?.code === 'not_verified') return <Navigate to={`/staff/call-desk/${id}`} replace />;
  if (customer.error) return <Alert tone="error">{customer.error.message}</Alert>;

  const c = customer.data.customer;
  const service = services.data.services.find((s) => s.code === f.serviceCode);
  const size = quote?.sizes.find((s) => s.code === f.sizeCode);
  const set = (k, v) => {
    setF((s) => ({ ...s, [k]: v }));
    setErrors((e) => ({ ...e, [k]: '' }));
    if (['serviceCode', 'pickup', 'destination', 'date', 'time', 'passengers', 'luggage', 'packageCode', 'channel', 'accessibility', 'childSeats'].includes(k)) {
      setQuote(null);
      setAlt(null);
    }
  };

  const journey = () => ({
    serviceCode: f.serviceCode,
    pickup: f.pickup,
    destination: service?.isHourly ? '' : f.destination,
    pickupAt: londonToIso(f.date, f.time) || '',
    passengers: Number(f.passengers),
    luggage: Number(f.luggage) || 0,
    accessibility: f.accessibility,
    childSeatAges: Array.from({ length: Number(f.childSeats) }, () => 4),
    pet: f.pet,
    ...(f.flightNo.trim() ? { flightNo: f.flightNo.trim() } : {}),
    ...(f.noteToDriver.trim() ? { noteToDriver: f.noteToDriver.trim() } : {}),
    ...(f.passengerName.trim() ? { passengerName: f.passengerName.trim(), passengerPhone: f.passengerPhone.trim() } : {}),
    ...(service?.isHourly ? { packageCode: f.packageCode } : {}),
  });

  const check = async (e) => {
    e.preventDefault();
    setError('');
    setAlt(null);
    const x = {};
    if (!f.pickup.trim()) x.pickup = 'Pickup location is required';
    if (!service?.isHourly && !f.destination.trim()) x.destination = 'Destination is required';
    if (!f.date) x.date = 'Choose a date';
    if (!f.time) x.time = 'Choose a time';
    setErrors(x);
    if (Object.keys(x).length) return;
    setBusy(true);
    try {
      const q = await api.post('/bookings/quote', { ...journey(), channel: f.channel });
      setQuote(q);
      setF((s) => ({ ...s, sizeCode: q.sizes.some((z) => z.code === s.sizeCode && z.fits && z.available > 0) ? s.sizeCode : '' }));
    } catch (err) {
      setErrors({ ...err.fields, date: err.fields?.pickupAt });
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setError('');
    setCardErrors({});
    let payment;
    if (pay === 'cash') payment = { method: 'cash' };
    if (pay === 'driver') payment = { method: 'driver' };
    if (pay === 'card') {
      const ce = validateCardForm(card);
      if (Object.keys(ce).length) return setCardErrors(ce);
      const { expMonth, expYear } = parseExpiry(card.expiry);
      payment = { method: 'card', card: { number: onlyDigits(card.number), expMonth, expYear, cvv: card.cvv, holder: card.holder.trim() } };
    }
    setBusy(true);
    try {
      const r = await api.post('/staff/bookings', { ...journey(), customerId: id, channel: f.channel, sizeCode: f.sizeCode, notifyPref: f.notifyPref, ...(payment ? { payment } : {}) });
      setDone(r);
    } catch (err) {
      setError(err.message);
      if (err.alternatives) setAlt(err.alternatives);
      if (err.fields) {
        const cf = {};
        for (const [k, m] of Object.entries(err.fields)) if (k.startsWith('payment.card.')) cf[k.replace('payment.card.', '').replace('expYear', 'expiry').replace('expMonth', 'expiry')] = m;
        setCardErrors(cf);
      }
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const b = done.booking;
    return (
      <div className="stack-lg medium" style={{ marginInline: 0 }}>
        <Alert tone="success"><strong>Booked for {c.fullName}.</strong> Reference <span className="mono strong">{b.ref}</span>. A confirmation email has been sent to the customer.</Alert>
        <div className="card stack">
          <Kv k="When" v={fmtDateTime(b.pickupAt)} />
          <Kv k="Journey" v={`${b.pickup} to ${b.destination}`} />
          <Kv k="Cab" v={`${b.size.label} - ${b.vehicle?.reg} (${b.vehicle?.colour} ${b.vehicle?.make})`} />
          <Kv k="Channel" v={b.channel === 'phone' ? 'Phone' : 'In person'} />
          <PriceBreakdown price={b.price} />
          <BookingExtras b={b} />
          <p className="small muted">{b.paymentStatus === 'paid' ? 'Paid.' : 'Not paid yet: the customer pays the driver in cash at the end of the journey.'}</p>
        </div>
        <div className="row">
          <Link to={`/staff/call-desk/${id}`} className="btn">Back to customer</Link>
          <Link to="/staff/call-desk" className="btn btn-subtle">Next caller</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <div><Link to={`/staff/call-desk/${id}`} className="small strong">&larr; {c.fullName}</Link></div>
      <div>
        <h2>Book for {c.fullName}</h2>
        <p className="muted" style={{ marginTop: 6 }}>Phone and in-person bookings do not get the 15% online discount.</p>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {alt && (
        <div className="card card-soft stack">
          {alt.sizes?.length > 0 && <div className="chips">{alt.sizes.map((s) => <button key={s.code} className="chip" onClick={() => set('sizeCode', s.code)}>{s.label}</button>)}</div>}
          {alt.times?.length > 0 && <div className="chips">{alt.times.map((t) => <button key={t} className="chip" onClick={() => { const p = londonParts(t); setF((s) => ({ ...s, date: p.date, time: p.time })); setQuote(null); setAlt(null); }}>{fmtShort(t)}</button>)}</div>}
        </div>
      )}

      <form className="card stack" onSubmit={check} noValidate>
        <datalist id="places">{(places.data?.locations || []).map((l) => <option key={l.name} value={l.name} />)}</datalist>
        <div className="form-grid two">
          <SelectField label="Booking channel" value={f.channel} onChange={(e) => set('channel', e.target.value)}>
            <option value="phone">Phone</option>
            <option value="in_person">In person</option>
          </SelectField>
          <SelectField label="Service" value={f.serviceCode} onChange={(e) => set('serviceCode', e.target.value)}>
            {services.data.services.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </SelectField>
          <TextField className="span-2" label="Pickup location" list="places" autoComplete="off" value={f.pickup} onChange={(e) => set('pickup', e.target.value)} error={errors.pickup} />
          {!service.isHourly && <TextField className="span-2" label="Destination" list="places" autoComplete="off" value={f.destination} onChange={(e) => set('destination', e.target.value)} error={errors.destination} />}
          <TextField label="Date" type="date" min={todayLondon()} value={f.date} onChange={(e) => set('date', e.target.value)} error={errors.date} />
          <TextField label="Pickup time" type="time" step="300" value={f.time} onChange={(e) => set('time', e.target.value)} error={errors.time} />
          <TextField label="Passengers" type="number" min="1" max="8" value={f.passengers} onChange={(e) => set('passengers', e.target.value)} error={errors.passengers} />
          <TextField label="Bags" type="number" min="0" max="12" value={f.luggage} onChange={(e) => set('luggage', e.target.value)} error={errors.luggage} />
          {service.isHourly && (
            <SelectField label="Package" value={f.packageCode} onChange={(e) => set('packageCode', e.target.value)} error={errors.packageCode}>
              {(packages.data?.packages || []).map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
            </SelectField>
          )}
          <SelectField label="Child seats" value={f.childSeats} onChange={(e) => set('childSeats', e.target.value)} error={errors.childSeatAges}>
            {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n === 0 ? 'None' : n}</option>)}
          </SelectField>
          <TextField label="Flight number (airport pickups)" value={f.flightNo} onChange={(e) => set('flightNo', e.target.value.toUpperCase())} error={errors.flightNo} />
          <fieldset className="span-2 row" style={{ border: 0, padding: 0, margin: 0, gap: 16 }}>
            <legend className="label" style={{ marginBottom: 8 }}>Accessibility (no extra charge) and pets</legend>
            {Object.entries(ACCESSIBILITY_LABEL).map(([k, l]) => (
              <label key={k} className="check">
                <input type="checkbox" checked={f.accessibility.includes(k)} onChange={() => set('accessibility', f.accessibility.includes(k) ? f.accessibility.filter((x) => x !== k) : [...f.accessibility, k])} />
                <span>{l}</span>
              </label>
            ))}
            <label className="check"><input type="checkbox" checked={f.pet} onChange={(e) => set('pet', e.target.checked)} /><span>Pet</span></label>
          </fieldset>
          <TextField label="Passenger name (if not the caller)" value={f.passengerName} onChange={(e) => set('passengerName', e.target.value)} error={errors.passengerName} />
          <TextField label="Passenger phone" type="tel" value={f.passengerPhone} onChange={(e) => set('passengerPhone', e.target.value)} error={errors.passengerPhone} />
          <TextField className="span-2" label="Note to the driver" value={f.noteToDriver} onChange={(e) => set('noteToDriver', e.target.value)} error={errors.noteToDriver} />
        </div>
        <div><button className="btn" disabled={busy}>{busy && !quote ? 'Checking...' : 'Check prices and availability'}</button></div>
      </form>

      {quote && (
        <>
          <section className="card stack">
            <h3>Cab and price</h3>
            <div className="stack-sm">
              {quote.sizes.map((s) => {
                const disabled = !s.fits || s.available === 0;
                return (
                  <button key={s.code} type="button" disabled={disabled} className={`option ${f.sizeCode === s.code ? 'selected' : ''}`} onClick={() => set('sizeCode', s.code)} aria-pressed={f.sizeCode === s.code}>
                    <span className="o-icon"><Icon name="car" /></span>
                    <span className="grow">
                      <div className="o-title">{s.label}</div>
                      <div className="o-sub">{!s.fits ? s.misfit : s.available === 0 ? 'Fully booked' : `${s.available} free`}</div>
                    </span>
                    <span className="strong" style={{ fontSize: 18 }}>{money(s.price.total)}</span>
                  </button>
                );
              })}
            </div>
            <p className="tiny">{quote.package ? quote.package.label : `About ${quote.distanceMiles} miles, ${quote.durationMinutes} minutes`}. Phone / in-person price: no online discount.{quote.night && ' Night surcharge applies.'}{quote.inZone && ' Central zone fee applies.'}</p>
          </section>

          {size && (
            <section className="card stack">
              <h3>Confirm</h3>
              <SelectField label="Keep the customer updated by" value={f.notifyPref} onChange={(e) => set('notifyPref', e.target.value)}>
                <option value="email">Email</option>
                <option value="text">Text message ({c.phone})</option>
                <option value="both">Email and text</option>
              </SelectField>
              <div className="field">
                <span className="label">Payment</span>
                <div className="option-grid">
                  {[['driver', 'Cash to the driver', 'Paid at the end of the journey'], ['cash', 'Cash received now', 'Walk-in: recorded as paid in person'], ['card', 'Card over the phone', 'Checked with the bank now']].map(([k, l, sub]) => (
                    <button key={k} type="button" className={`option ${pay === k ? 'selected' : ''}`} onClick={() => setPay(k)} aria-pressed={pay === k}>
                      <span className="o-icon"><Icon name={k === 'card' ? 'card' : k === 'cash' ? 'tag' : 'clock'} /></span>
                      <span><div className="o-title">{l}</div><div className="o-sub">{sub}</div></span>
                    </button>
                  ))}
                </div>
              </div>
              {pay === 'card' && <CardForm value={card} onChange={setCard} errors={cardErrors} />}
              <hr className="sep" />
              <PriceBreakdown price={size.price} />
              <button className="btn btn-lg btn-block" onClick={confirm} disabled={busy}>{busy ? 'Booking...' : `Confirm booking - ${money(size.price.total)}`}</button>
            </section>
          )}
        </>
      )}
    </div>
  );
}
