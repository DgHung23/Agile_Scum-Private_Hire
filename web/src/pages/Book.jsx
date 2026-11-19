import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Icon } from '../icons.jsx';
import { ACCESSIBILITY_LABEL, fmtDateTime, fmtShort, londonToIso, money, todayLondon } from '../format.js';
import { Alert, Kv, Loading, SelectField, TextField, useLoad } from '../ui.jsx';
import { BookingExtras, PriceBreakdown } from '../components/BookingBits.jsx';
import Checkout from '../components/Checkout.jsx';
import { SERVICE_ICONS } from './Home.jsx';

const DRAFT_KEY = 'ph_booking_draft';
const BLANK = {
  serviceCode: '', pickup: '', destination: '', date: '', time: '', asap: false, passengers: 1, luggage: 0, packageCode: 'half_day',
  sizeCode: '', notifyPref: 'email', offerCode: '', childSeatAges: [], pet: false, accessibility: [], forOther: false,
  passengerName: '', passengerPhone: '', flightNo: '', noteToDriver: '', withReturn: false, returnDate: '', returnTime: '',
  acceptTerms: false, pendingId: '',
};
const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;
const FLIGHT_RE = /^[A-Z0-9]{2,3}\s?\d{1,4}[A-Z]?$/i;

const loadDraft = () => {
  try {
    return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null');
  } catch {
    return null;
  }
};
const saveDraft = (d) => {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* ignore */
  }
};
export const clearDraft = () => {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
};

const STEPS = ['Service', 'Journey', 'Cab & price', 'Review', 'Payment'];

function Stepper({ step }) {
  return (
    <div>
      <div className="step-label">Step {step + 1} of {STEPS.length}: {STEPS[step]}</div>
      <div className="stepper" aria-hidden="true">
        {STEPS.map((s, i) => <div key={s} className={`step ${i < step ? 'done' : i === step ? 'current' : ''}`} />)}
      </div>
    </div>
  );
}

function Summary({ draft, service, size, quote, step }) {
  const pickupAt = draft.date && draft.time ? londonToIso(draft.date, draft.time) : null;
  return (
    <aside className="card card-soft stack sticky" aria-label="Booking summary">
      <h3>Your journey</h3>
      {!service ? (
        <p className="muted small">Choose a service to begin.</p>
      ) : (
        <div className="stack-sm small">
          <Kv k="Service" v={service.label} />
          {draft.pickup && <Kv k="From" v={draft.pickup} />}
          {draft.destination && !service.isHourly && <Kv k="To" v={draft.destination} />}
          {service.isHourly && step >= 1 && quote?.package && <Kv k="Package" v={quote.package.label} />}
          {draft.asap && step >= 1 ? <Kv k="When" v="As soon as possible" /> : pickupAt && <Kv k="When" v={fmtDateTime(pickupAt)} />}
          {draft.withReturn && draft.returnDate && draft.returnTime && <Kv k="Return" v={fmtDateTime(londonToIso(draft.returnDate, draft.returnTime))} />}
          {step >= 1 && <Kv k="Passengers" v={`${draft.passengers}${Number(draft.luggage) ? `, ${draft.luggage} bag${Number(draft.luggage) === 1 ? '' : 's'}` : ''}`} />}
          {size && <Kv k="Cab" v={size.label} />}
        </div>
      )}
      {size && quote && (
        <>
          <hr className="sep" />
          <PriceBreakdown price={size.price} discountPct={quote.onlineDiscountPct} />
          {size.returnPrice && (
            <>
              <div className="small strong" style={{ marginTop: 8 }}>Return journey</div>
              <Kv cls="total" k="Return total" v={money(size.returnPrice.total)} />
              <Kv cls="total" k="To pay now" v={money(size.price.total + size.returnPrice.total)} />
            </>
          )}
        </>
      )}
      {!size && step < 2 && (
        <p className="tiny"><Icon name="tag" size={12} /> Every online booking is {15}% cheaper than phone or in-person.</p>
      )}
    </aside>
  );
}

export default function Book() {
  const { user } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const services = useLoad(() => api.publicGet('/catalog/services'));
  const places = useLoad(() => api.publicGet('/catalog/locations?limit=50'));
  const packages = useLoad(() => api.publicGet('/catalog/packages'));
  const wallet = useLoad(() => (user?.role === 'customer' ? api.get('/offers/mine') : Promise.resolve({ offers: [] })), [user?.id]);

  const [draft, setDraft] = useState(() => {
    const d = { ...BLANK, ...(loadDraft() || {}) };
    const p = Object.fromEntries(params.entries());
    if (p.service) d.serviceCode = p.service;
    if (p.pickup) d.pickup = p.pickup;
    if (p.destination) d.destination = p.destination;
    if (p.date) d.date = p.date;
    if (p.time) d.time = p.time;
    if (p.passengers) d.passengers = Number(p.passengers) || 1;
    if (p.size) d.sizeCode = p.size;
    return d;
  });
  const [step, setStep] = useState(() => {
    const d = loadDraft();
    if (d?.step) return d.step;
    return params.get('service') ? 1 : params.get('pickup') || params.get('destination') ? 0 : 0;
  });
  const [quote, setQuote] = useState(null);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [alt, setAlt] = useState(null);
  const [busy, setBusy] = useState(false);
  const pendingError = useRef('');
  // Coming back from PayPal or the bank (simulated): finish the payment on the payment step.
  const [redirectResult] = useState(() => loc.state?.redirect || null);
  useEffect(() => {
    if (!redirectResult) return;
    setStep(4);
    nav(loc.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the draft so logging in mid-booking does not lose anything
  useEffect(() => saveDraft({ ...draft, step }), [draft, step]);

  const set = (k, v) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setErrors((e) => ({ ...e, [k]: '' }));
  };

  const service = useMemo(() => services.data?.services.find((s) => s.code === draft.serviceCode), [services.data, draft.serviceCode]);
  const size = quote?.sizes.find((s) => s.code === draft.sizeCode);

  const pickupIso = () => londonToIso(draft.date, draft.time);

  const isAirportPickup = () => (places.data?.locations || []).some((l) => l.kind === 'airport' && l.name.toLowerCase() === draft.pickup.trim().toLowerCase());

  const journeyBody = (offerCode = draft.offerCode) => ({
    serviceCode: draft.serviceCode,
    pickup: draft.pickup,
    destination: service?.isHourly ? '' : draft.destination,
    ...(draft.asap ? { asap: true } : { pickupAt: pickupIso() || '' }),
    passengers: Number(draft.passengers),
    luggage: Number(draft.luggage) || 0,
    childSeatAges: draft.childSeatAges.map(Number),
    pet: !!draft.pet,
    accessibility: draft.accessibility,
    ...(draft.forOther ? { passengerName: draft.passengerName.trim(), passengerPhone: draft.passengerPhone.trim() } : {}),
    ...(draft.flightNo.trim() ? { flightNo: draft.flightNo.trim() } : {}),
    ...(draft.noteToDriver.trim() ? { noteToDriver: draft.noteToDriver.trim() } : {}),
    ...(service?.isHourly ? { packageCode: draft.packageCode } : {}),
    ...(draft.withReturn && !service?.isHourly && draft.returnDate && draft.returnTime ? { returnAt: londonToIso(draft.returnDate, draft.returnTime) } : {}),
    ...(offerCode ? { offerCode } : {}),
  });

  // ID-29 and ID-30 checks, mirrored by the server.
  const validateJourney = () => {
    const e = {};
    if (!draft.pickup.trim()) e.pickup = 'Pickup location is required';
    if (!service?.isHourly) {
      if (!draft.destination.trim()) e.destination = 'Destination is required';
      else if (draft.destination.trim().toLowerCase() === draft.pickup.trim().toLowerCase()) e.destination = 'Pickup and destination cannot be the same place';
    }
    if (!draft.asap) {
      if (!draft.date) e.date = 'Choose a date';
      if (!draft.time) e.time = 'Choose a time';
      if (draft.date && draft.time && new Date(pickupIso()).getTime() < Date.now() + 30 * 60_000) e.date = 'Choose a pickup at least 30 minutes from now';
    }
    const n = Number(draft.passengers);
    if (!Number.isInteger(n) || n < 1) e.passengers = 'Enter at least 1 passenger';
    else if (n > 8) e.passengers = 'We carry up to 8 passengers in one cab';
    const bags = Number(draft.luggage);
    if (!Number.isInteger(bags) || bags < 0 || bags > 12) e.luggage = 'Enter 0 to 12 bags';
    if (draft.childSeatAges.length >= n && draft.childSeatAges.length > 0) e.childSeatAges = 'Children count as passengers, and an adult must travel too';
    if (draft.forOther) {
      if (!draft.passengerName.trim()) e.passengerName = "Enter the passenger's name";
      if (!PHONE_RE.test(draft.passengerPhone.trim())) e.passengerPhone = 'Enter a valid telephone number, like 07700 900123';
    }
    if (draft.flightNo.trim() && !FLIGHT_RE.test(draft.flightNo.trim())) e.flightNo = 'Enter a flight number like BA 117';
    if (draft.withReturn && !service?.isHourly && (!draft.returnDate || !draft.returnTime)) e.returnAt = 'Choose the return date and time';
    return e;
  };

  const fetchQuote = async (offerOverride) => {
    setError('');
    setAlt(null);
    const e = validateJourney();
    setErrors(e);
    if (Object.keys(e).length) return false;
    setBusy(true);
    try {
      const q = await api.post('/bookings/quote', journeyBody(offerOverride));
      setQuote(q);
      // keep the chosen size only if it still fits and is free
      const keep = q.sizes.find((s) => s.code === draft.sizeCode && s.fits && s.available > 0);
      if (!keep) setDraft((d) => ({ ...d, sizeCode: '' }));
      return true;
    } catch (err) {
      const f = err.fields || {};
      setErrors({ ...f, date: f.pickupAt || '', returnAt: f.returnAt || '' });
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const next = async () => {
    if (step === 0) {
      if (!draft.serviceCode) return setError('Choose a service to continue');
      setError('');
      return setStep(1);
    }
    if (step === 1) {
      if (await fetchQuote()) setStep(2);
      return;
    }
    if (step === 2) {
      if (!draft.sizeCode) return setError('Choose a cab size to continue');
      setError('');
      return setStep(3);
    }
  };

  // Step 4 (Checkout): the first attempt creates the booking; it waits for payment while the cab is held.
  const createBooking = (payment) =>
    api.post('/bookings', { ...journeyBody(), sizeCode: draft.sizeCode, notifyPref: draft.notifyPref, acceptTerms: true, payment });

  const booked = (r) => {
    clearDraft();
    nav(`/trips/${r.booking.id}`, { replace: true, state: { justBooked: true } });
  };

  const checkoutProblem = async (err) => {
    if (err.code === 'no_availability' || err.code === 'no_availability_return') {
      setAlt(err.alternatives || null);
      setError(err.message);
    } else if (err.fields?.offerCode) {
      // the coupon was used or expired since it was applied: drop it and go back to the review step
      setDraft((d) => ({ ...d, offerCode: '' }));
      await fetchQuote('');
      setError(err.fields.offerCode);
      setStep(3);
    } else if (err.fields && Object.keys(err.fields).length) {
      setErrors(err.fields);
      setError(err.message);
      setStep(1);
    }
  };

  // Leaving the payment step to change the journey releases the held cab.
  const leavePayment = (to) => {
    if (draft.pendingId) api.post(`/bookings/${draft.pendingId}/abandon`).catch(() => {});
    setDraft((d) => ({ ...d, pendingId: '' }));
    setError('');
    setStep(to);
  };

  const [offerInput, setOfferInput] = useState('');
  const [offerError, setOfferError] = useState('');
  const pickCoupon = async (code) => {
    setOfferError('');
    if (await fetchQuote(code)) setDraft((d) => ({ ...d, offerCode: code }));
  };
  const applyOffer = async () => {
    setOfferError('');
    if (!offerInput.trim()) return setOfferError('Enter a coupon code');
    try {
      await api.post('/offers/validate', { code: offerInput });
      if (await fetchQuote(offerInput.trim())) {
        setDraft((d) => ({ ...d, offerCode: offerInput.trim() }));
        setOfferInput('');
      }
    } catch (err) {
      setOfferError(err.fields?.offerCode || err.message);
    }
  };
  const removeOffer = async () => {
    setDraft((d) => ({ ...d, offerCode: '' }));
    await fetchQuote('');
  };

  const toggleIn = (k, v) => set(k, draft[k].includes(v) ? draft[k].filter((x) => x !== v) : [...draft[k], v]);
  const setSeats = (n) => set('childSeatAges', Array.from({ length: n }, (_, i) => draft.childSeatAges[i] ?? 3));

  const takeAlternativeSize = async (code) => {
    setDraft((d) => ({ ...d, sizeCode: code }));
    setAlt(null);
    setError('');
    if (await fetchQuote()) setStep(3);
  };
  const takeAlternativeTime = async (iso) => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso));
    const g = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    setDraft((d) => ({ ...d, date: `${g.year}-${g.month}-${g.day}`, time: `${g.hour === '24' ? '00' : g.hour}:${g.minute}` }));
    setAlt(null);
    setError('');
    setStep(1);
  };

  // Restoring a saved draft (e.g. coming back from login): quotes are not stored, so fetch it again
  useEffect(() => {
    if (step >= 2 && !quote && service) {
      fetchQuote().then((okay) => {
        if (!okay) setStep(1);
        else if (pendingError.current) {
          setError(pendingError.current);
          pendingError.current = '';
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);

  if (services.loading) return <div className="container page"><Loading /></div>;
  if (step >= 2 && !quote) return <div className="container page"><Loading /></div>;

  return (
    <div className="container page">
      <div className="split">
        <div className="stack-lg">
          <div>
            <h2>Book a minicab</h2>
            <p className="muted" style={{ marginTop: 6 }}>Prices are shown up front. Online bookings are 15% cheaper.</p>
          </div>
          <Stepper step={step} />

          {error && <Alert tone="error">{error}</Alert>}
          {alt && (
            <div className="card card-soft stack">
              {alt.sizes?.length > 0 && (
                <div className="stack-sm">
                  <div className="strong">Available at this time in another size</div>
                  <div className="chips">
                    {alt.sizes.map((s) => (
                      <button key={s.code} className="chip" onClick={() => takeAlternativeSize(s.code)}>{s.label}</button>
                    ))}
                  </div>
                </div>
              )}
              {alt.times?.length > 0 && (
                <div className="stack-sm">
                  <div className="strong">Or choose a nearby time for the same cab</div>
                  <div className="chips">
                    {alt.times.map((t) => (
                      <button key={t} className="chip" onClick={() => takeAlternativeTime(t)}>{fmtShort(t)}</button>
                    ))}
                  </div>
                </div>
              )}
              {!alt.sizes?.length && !alt.times?.length && <p className="small">Please try another day, or call us on 020 7000 0000.</p>}
            </div>
          )}

          {step === 0 && (
            <div className="stack">
              <div className="option-grid">
                {(services.data?.services || []).map((s) => (
                  <button key={s.code} type="button" className={`option ${draft.serviceCode === s.code ? 'selected' : ''}`}
                    onClick={() => { set('serviceCode', s.code); setError(''); setStep(1); }}>
                    <span className="o-icon"><Icon name={SERVICE_ICONS[s.code] || 'car'} /></span>
                    <span>
                      <div className="o-title">{s.label}</div>
                      <div className="o-sub">{s.description}</div>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="stack">
              <datalist id="places">
                {(places.data?.locations || []).map((l) => <option key={l.name} value={l.name}>{l.kind}</option>)}
              </datalist>
              <div className="form-grid two">
                <TextField className="span-2" label="Pickup location" list="places" autoComplete="off" placeholder="Address, station, airport or hotel"
                  value={draft.pickup} onChange={(e) => set('pickup', e.target.value)} error={errors.pickup} />
                {!service?.isHourly && (
                  <TextField className="span-2" label="Destination" list="places" autoComplete="off" placeholder="Where are you going?"
                    value={draft.destination} onChange={(e) => set('destination', e.target.value)} error={errors.destination}
                    hint={service?.needsAirport ? 'One end of the journey must be an airport' : undefined} />
                )}
                <label className="check span-2">
                  <input type="checkbox" checked={draft.asap} onChange={(e) => set('asap', e.target.checked)} />
                  <span>As soon as possible <span className="muted small">(the earliest pickup is 30 minutes from now; we are a pre-booked service)</span></span>
                </label>
                {!draft.asap && (
                  <>
                    <TextField label="Date" type="date" min={todayLondon()} value={draft.date} onChange={(e) => set('date', e.target.value)} error={errors.date || errors.pickupAt} />
                    <TextField label="Pickup time" type="time" step="300" value={draft.time} onChange={(e) => set('time', e.target.value)} error={errors.time} />
                  </>
                )}
                <TextField label="Passengers" type="number" inputMode="numeric" min="1" max="8" value={draft.passengers}
                  onChange={(e) => set('passengers', e.target.value)} error={errors.passengers} hint="Up to 8 in one cab" />
                <TextField label="Bags" type="number" inputMode="numeric" min="0" max="12" value={draft.luggage}
                  onChange={(e) => set('luggage', e.target.value)} error={errors.luggage} hint="Suitcases and large bags" />
                {service?.isHourly && (
                  <SelectField className="span-2" label="Daily hire package" value={draft.packageCode} onChange={(e) => set('packageCode', e.target.value)} error={errors.packageCode}>
                    {(packages.data?.packages || []).map((p) => (
                      <option key={p.code} value={p.code}>{p.label} - from {money(p.price)}</option>
                    ))}
                  </SelectField>
                )}
                {(service?.needsAirport || isAirportPickup()) && (
                  <TextField className="span-2" label="Flight number (if we collect you from the airport)" value={draft.flightNo} placeholder="e.g. BA 117"
                    onChange={(e) => set('flightNo', e.target.value.toUpperCase())} error={errors.flightNo}
                    hint="We follow your landing time, with no waiting charge if the flight is late." />
                )}
                {!service?.isHourly && (
                  <div className="span-2 stack-sm">
                    <label className="check">
                      <input type="checkbox" checked={draft.withReturn} onChange={(e) => set('withReturn', e.target.checked)} />
                      <span>Add a return journey</span>
                    </label>
                    {draft.withReturn && (
                      <div className="form-grid two">
                        <TextField label="Return date" type="date" min={draft.date || todayLondon()} value={draft.returnDate} onChange={(e) => set('returnDate', e.target.value)} error={errors.returnAt} />
                        <TextField label="Return pickup time" type="time" step="300" value={draft.returnTime} onChange={(e) => set('returnTime', e.target.value)} />
                      </div>
                    )}
                  </div>
                )}
              </div>
              <details className="card card-soft" open={!!(draft.childSeatAges.length || draft.pet || draft.accessibility.length || draft.forOther || draft.noteToDriver)}>
                <summary className="strong" style={{ cursor: 'pointer' }}>Child seats, pets, accessibility and other options</summary>
                <div className="form-grid two" style={{ marginTop: 16 }}>
                  <SelectField label="Child seats" value={draft.childSeatAges.length} onChange={(e) => setSeats(Number(e.target.value))} error={errors.childSeatAges}>
                    {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n === 0 ? 'None' : n}</option>)}
                  </SelectField>
                  <div className="row" style={{ gap: 8 }}>
                    {draft.childSeatAges.map((a, i) => (
                      <SelectField key={i} label={`Child ${i + 1} age`} value={a}
                        onChange={(e) => set('childSeatAges', draft.childSeatAges.map((x, j) => (j === i ? Number(e.target.value) : x)))}>
                        {Array.from({ length: 12 }, (_, y) => <option key={y} value={y}>{y === 0 ? 'Under 1' : `${y} yr`}</option>)}
                      </SelectField>
                    ))}
                  </div>
                  <label className="check span-2">
                    <input type="checkbox" checked={draft.pet} onChange={(e) => set('pet', e.target.checked)} />
                    <span>I am bringing a pet <span className="muted small">(an assistance dog is not a pet - choose it below)</span></span>
                  </label>
                  <fieldset className="span-2 stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="label" style={{ marginBottom: 8 }}>Accessibility (always free of charge)</legend>
                    {Object.entries(ACCESSIBILITY_LABEL).map(([k, l]) => (
                      <label key={k} className="check">
                        <input type="checkbox" checked={draft.accessibility.includes(k)} onChange={() => toggleIn('accessibility', k)} />
                        <span>{l}</span>
                      </label>
                    ))}
                  </fieldset>
                  <label className="check span-2">
                    <input type="checkbox" checked={draft.forOther} onChange={(e) => set('forOther', e.target.checked)} />
                    <span>I am booking for someone else <span className="muted small">(their phone gets the driver texts)</span></span>
                  </label>
                  {draft.forOther && (
                    <>
                      <TextField label="Passenger name" value={draft.passengerName} onChange={(e) => set('passengerName', e.target.value)} error={errors.passengerName} />
                      <TextField label="Passenger phone" type="tel" value={draft.passengerPhone} onChange={(e) => set('passengerPhone', e.target.value)} error={errors.passengerPhone} />
                    </>
                  )}
                  <TextField className="span-2" label="Note to the driver (optional)" value={draft.noteToDriver} maxLength={300}
                    onChange={(e) => set('noteToDriver', e.target.value)} error={errors.noteToDriver} placeholder="e.g. Ring the bell for flat 3" />
                </div>
              </details>
              <p className="small muted">
                <Link to="#" className="link-btn" onClick={(e) => { e.preventDefault(); setStep(0); }}>Change service</Link> ({service?.label})
              </p>
            </div>
          )}

          {step === 2 && quote && (
            <div className="stack">
              <div className="option-grid" style={{ gridTemplateColumns: '1fr' }}>
                {quote.sizes.map((s) => {
                  const disabled = !s.fits || s.available === 0;
                  const reason = !s.fits ? s.misfit : s.available === 0 ? (draft.accessibility.includes('wheelchair') ? 'No wheelchair-accessible cab of this size free' : 'Fully booked at this time') : s.available <= 2 ? `Only ${s.available} left` : '';
                  return (
                    <button key={s.code} type="button" disabled={disabled} className={`option ${draft.sizeCode === s.code ? 'selected' : ''}`}
                      aria-pressed={draft.sizeCode === s.code} onClick={() => { set('sizeCode', s.code); setError(''); }}>
                      <span className="o-icon"><Icon name="car" /></span>
                      <span className="grow">
                        <div className="o-title">{s.label}</div>
                        <div className="o-sub">{s.seats} seats, {s.luggage} bags &middot; {reason || 'Available'}</div>
                      </span>
                      <span style={{ textAlign: 'right' }}>
                        {s.price.discountOnline > 0 && <div className="strike small">{money(s.price.full)}</div>}
                        <div className="strong" style={{ fontSize: 18 }}>{money(s.price.total)}</div>
                        {s.returnPrice && <div className="tiny">+ return {money(s.returnPrice.total)}</div>}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="tiny">
                {quote.package ? quote.package.label : `About ${quote.distanceMiles} miles${quote.distanceSource === 'estimate' ? ' (estimated from the addresses you typed)' : ''}, ${quote.durationMinutes} minutes`}.
                {quote.night && ' Night surcharge applies (22:00 to 06:00).'}{quote.inZone && ' Central London zone fee applies.'}
                {quote.channel === 'online' && ` Prices include your ${quote.onlineDiscountPct}% online discount.`}
              </p>
            </div>
          )}

          {step === 3 && size && (
            <div className="stack">
              <div className="card stack">
                <div className="row-between"><h3>Journey</h3><button className="btn btn-ghost btn-sm" onClick={() => setStep(1)}><Icon name="edit" size={16} /> Edit</button></div>
                <Kv k="Service" v={service.label} />
                <Kv k="Pickup" v={draft.pickup} />
                {!service.isHourly && <Kv k="Destination" v={draft.destination} />}
                {quote.package && <Kv k="Package" v={quote.package.label} />}
                <Kv k="When" v={fmtDateTime(quote.pickupAt)} />
                {quote.returnAt && <Kv k="Return" v={fmtDateTime(quote.returnAt)} />}
                <Kv k="Passengers" v={draft.passengers} />
                <BookingExtras b={{
                  luggage: Number(draft.luggage), childSeatAges: draft.childSeatAges, pet: draft.pet, accessibility: draft.accessibility,
                  passenger: draft.forOther ? { name: draft.passengerName, phone: draft.passengerPhone } : null,
                  flightNo: draft.flightNo.trim().toUpperCase(), noteToDriver: draft.noteToDriver.trim(),
                }} />
                <div className="row-between"><h3 style={{ fontSize: 16 }}>Cab</h3><button className="btn btn-ghost btn-sm" onClick={() => setStep(2)}><Icon name="edit" size={16} /> Change</button></div>
                <Kv k="Size" v={size.label} />
              </div>

              <div className="card stack">
                <h3>How should we keep you updated?</h3>
                <div className="option-grid">
                  {[['email', 'Email', 'Confirmation and journey emails'], ['text', 'Text message', 'Car details 10-15 minutes before arrival'], ['both', 'Email and text', 'Both of the above']].map(([v, l, sub]) => (
                    <button key={v} type="button" className={`option ${draft.notifyPref === v ? 'selected' : ''}`} onClick={() => set('notifyPref', v)} aria-pressed={draft.notifyPref === v}>
                      <span className="o-icon"><Icon name={v === 'email' ? 'mail' : v === 'text' ? 'phone' : 'bell'} /></span>
                      <span><div className="o-title">{l}</div><div className="o-sub">{sub}</div></span>
                    </button>
                  ))}
                </div>
                {['text', 'both'].includes(draft.notifyPref) && (
                  <Alert tone="info" icon="phone">
                    We will text <strong>{draft.forOther ? draft.passengerPhone : user?.phone || 'the telephone number on your account'}</strong>.{' '}
                    {user ? <Link to="/account" className="strong">Wrong number? Update your profile.</Link> : 'Log in to check which number we have.'}
                  </Alert>
                )}
              </div>

              <div className="card stack">
                <h3>Coupon</h3>
                {quote.offer ? (
                  <div className="row-between">
                    <span><span className="badge green"><Icon name="check" size={12} /> {quote.offer.code}</span> {money(quote.offer.amount)} off applied</span>
                    <button className="btn btn-ghost btn-sm" onClick={removeOffer}>Remove</button>
                  </div>
                ) : user?.role === 'customer' ? (
                  <div className="stack-sm">
                    {wallet.data?.offers.length > 0 && (
                      <div className="stack-sm">
                        <div className="label">My coupons</div>
                        <div className="chips">
                          {wallet.data.offers.map((o) => (
                            <button key={o.code} type="button" className="chip" onClick={() => pickCoupon(o.code)}>
                              <Icon name="gift" size={14} /> {money(o.amount)} off &middot; {o.code}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                      <div className="grow">
                        <TextField label="Have a coupon code?" value={offerInput} error={offerError} placeholder="e.g. PH7K2M9Q" autoComplete="off"
                          onChange={(e) => { setOfferInput(e.target.value.toUpperCase()); setOfferError(''); }} />
                      </div>
                      <button className="btn btn-secondary" style={{ marginTop: 26 }} onClick={applyOffer} type="button">Apply</button>
                    </div>
                  </div>
                ) : <p className="small muted">Log in to use a coupon.</p>}
                <p className="tiny">One coupon per booking. It comes off after your 15% online discount, and the fare never falls below {money(5)}.</p>
              </div>

              <div className="card stack">
                <h3>Price</h3>
                <PriceBreakdown price={size.price} discountPct={quote.onlineDiscountPct} offerCode={quote.offer?.code} />
                {size.returnPrice && (
                  <>
                    <div className="strong small" style={{ marginTop: 8 }}>Return journey</div>
                    <PriceBreakdown price={size.returnPrice} discountPct={quote.onlineDiscountPct} />
                    <Kv cls="total" k="To pay now" v={money(size.price.total + size.returnPrice.total)} />
                  </>
                )}
              </div>

              <label className="check card" style={{ alignItems: 'flex-start' }}>
                <input type="checkbox" checked={draft.acceptTerms} onChange={(e) => set('acceptTerms', e.target.checked)} />
                <span>
                  I accept the <Link to="/terms" target="_blank" className="strong">terms and cancellation policy</Link>: free cancellation or changes up to
                  24 hours before pickup; after that, please call us. The 14-day cooling-off period does not apply to booked journeys.
                </span>
              </label>

              {!user ? (
                <div className="card card-dark stack">
                  <h3>Log in to confirm your booking</h3>
                  <p className="muted">Your journey is saved. Log in or create an account and you will come straight back here.</p>
                  <div className="row">
                    <Link to="/login" state={{ from: loc.pathname }} className="btn btn-light">Log in</Link>
                    <Link to="/register" className="btn" style={{ background: 'transparent', border: '1px solid #fff' }}>Create account</Link>
                  </div>
                </div>
              ) : user.role !== 'customer' ? (
                <Alert tone="warn">You are signed in as staff. Use the Call desk to book for a customer.</Alert>
              ) : (
                <button className="btn btn-lg btn-block" disabled={!draft.acceptTerms} onClick={() => { setError(''); setStep(4); }}>
                  Continue to payment - {money(size.price.total + (size.returnPrice?.total || 0))}
                </button>
              )}
            </div>
          )}

          {step < 3 && (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              {step > 0 ? <button className="btn btn-subtle" onClick={() => { setError(''); setStep(step - 1); }}>Back</button> : <span />}
              {step > 0 && <button className="btn btn-lg" onClick={next} disabled={busy}>{busy ? 'Checking...' : step === 1 ? 'See prices' : 'Continue'}</button>}
            </div>
          )}
          {step === 3 && <div><button className="btn btn-subtle" onClick={() => setStep(2)}>Back</button></div>}
          {step === 3 && !draft.acceptTerms && user?.role === 'customer' && <p className="tiny">Tick the box above to accept the terms before paying.</p>}

          {step === 4 && size && user?.role === 'customer' && (
            <div className="stack">
              <Checkout
                amount={size.price.total + (size.returnPrice?.total || 0)}
                create={createBooking}
                pendingId={draft.pendingId || null}
                onPending={(id) => setDraft((d) => ({ ...d, pendingId: id || '' }))}
                onDone={booked}
                onFieldErrors={checkoutProblem}
                returnTo="/book"
                redirectResult={redirectResult}
              />
              <div><button className="btn btn-subtle" onClick={() => leavePayment(3)}>Back to review</button></div>
            </div>
          )}
          {step === 4 && !(user?.role === 'customer') && (
            <Alert tone="warn">Log in with a customer account to pay. <Link to="/login" state={{ from: loc.pathname }} className="strong">Log in</Link></Alert>
          )}
        </div>

        <Summary draft={draft} service={service} size={size} quote={quote} step={step} />
      </div>
    </div>
  );
}
