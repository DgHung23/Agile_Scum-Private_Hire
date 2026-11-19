import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Icon } from '../icons.jsx';
import { fmtDateTime, fmtShort, londonToIso, money, todayLondon } from '../format.js';
import { Alert, Field, Kv, Loading, SelectField, TextField, useLoad } from '../ui.jsx';
import { PriceBreakdown } from '../components/BookingBits.jsx';
import PaymentStep from '../components/PaymentStep.jsx';
import { SERVICE_ICONS } from './Home.jsx';

const DRAFT_KEY = 'ph_booking_draft';
const BLANK = { serviceCode: '', pickup: '', destination: '', date: '', time: '', passengers: 1, hours: 4, sizeCode: '', notifyPref: 'email' };

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
          {service.isHourly && step >= 1 && <Kv k="Hire length" v={`${draft.hours} hours`} />}
          {pickupAt && <Kv k="When" v={fmtDateTime(pickupAt)} />}
          {step >= 1 && <Kv k="Passengers" v={draft.passengers} />}
          {size && <Kv k="Cab" v={size.label} />}
        </div>
      )}
      {size && quote && (
        <>
          <hr className="sep" />
          <PriceBreakdown price={size.price} discountPct={quote.onlineDiscountPct} />
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

  const [draft, setDraft] = useState(() => {
    const d = { ...BLANK, ...(loadDraft() || {}) };
    const p = Object.fromEntries(params.entries());
    if (p.service) d.serviceCode = p.service;
    if (p.pickup) d.pickup = p.pickup;
    if (p.destination) d.destination = p.destination;
    if (p.date) d.date = p.date;
    if (p.time) d.time = p.time;
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
  const [payErrors, setPayErrors] = useState({});
  const pendingError = useRef('');

  // Returning from the (simulated) PayPal page
  useEffect(() => {
    const pp = loc.state?.paypal;
    if (!pp) return;
    if (pp.status === 'approved') setDraft((d) => ({ ...d, paypalToken: pp.token, paypalPayer: pp.payer }));
    else pendingError.current = 'The PayPal payment was cancelled. You have not been charged - choose a payment method to try again.';
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

  const journeyBody = () => ({
    serviceCode: draft.serviceCode,
    pickup: draft.pickup,
    destination: service?.isHourly ? '' : draft.destination,
    pickupAt: pickupIso() || '',
    passengers: Number(draft.passengers),
    ...(service?.isHourly ? { hours: Number(draft.hours) } : {}),
  });

  const validateJourney = () => {
    const e = {};
    if (!draft.pickup.trim()) e.pickup = 'Pickup location is required';
    if (!service?.isHourly) {
      if (!draft.destination.trim()) e.destination = 'Destination is required';
      else if (draft.destination.trim().toLowerCase() === draft.pickup.trim().toLowerCase()) e.destination = 'Pickup and destination cannot be the same place';
    }
    if (!draft.date) e.date = 'Choose a date';
    if (!draft.time) e.time = 'Choose a time';
    if (draft.date && draft.time && new Date(pickupIso()).getTime() < Date.now()) e.date = 'Choose a date and time in the future';
    const n = Number(draft.passengers);
    if (!Number.isInteger(n) || n < 1) e.passengers = 'Enter at least 1 passenger';
    return e;
  };

  const fetchQuote = async () => {
    setError('');
    setAlt(null);
    const e = validateJourney();
    setErrors(e);
    if (Object.keys(e).length) return false;
    setBusy(true);
    try {
      const q = await api.post('/bookings/quote', journeyBody());
      setQuote(q);
      // keep the chosen size only if it still fits and is free
      const keep = q.sizes.find((s) => s.code === draft.sizeCode && s.fitsPassengers && s.available > 0);
      if (!keep) setDraft((d) => ({ ...d, sizeCode: '' }));
      return true;
    } catch (err) {
      const f = err.fields || {};
      setErrors({ ...f, date: f.pickupAt || '' });
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

  const startPayPal = async () => {
    const r = await api.post('/payments/paypal/start', { amount: size.price.total });
    nav(`/paypal-mock?token=${encodeURIComponent(r.token)}`);
  };

  const confirm = async (payment) => {
    setError('');
    setAlt(null);
    setPayErrors({});
    setBusy(true);
    try {
      const r = await api.post('/bookings', { ...journeyBody(), sizeCode: draft.sizeCode, notifyPref: draft.notifyPref, payment });
      clearDraft();
      nav(`/trips/${r.booking.id}`, { replace: true, state: { justBooked: true } });
    } catch (err) {
      setError(err.message);
      if (err.code === 'no_availability') {
        setAlt(err.alternatives || null);
      } else if (err.code === 'payment_declined') {
        if (payment.method === 'paypal') setDraft((d) => ({ ...d, paypalToken: '', paypalPayer: '' }));
      } else if (err.fields && Object.keys(err.fields).length) {
        const payF = Object.fromEntries(Object.entries(err.fields).filter(([k]) => k.startsWith('payment.')));
        if (Object.keys(payF).length) setPayErrors(payF);
        else {
          setErrors(err.fields);
          setStep(1);
        }
      }
    } finally {
      setBusy(false);
    }
  };

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
                <TextField label="Date" type="date" min={todayLondon()} value={draft.date} onChange={(e) => set('date', e.target.value)} error={errors.date} />
                <TextField label="Pickup time" type="time" step="300" value={draft.time} onChange={(e) => set('time', e.target.value)} error={errors.time} />
                <TextField label="Passengers" type="number" inputMode="numeric" min="1" max="16" value={draft.passengers}
                  onChange={(e) => set('passengers', e.target.value)} error={errors.passengers} />
                {service?.isHourly && (
                  <SelectField label="How many hours?" value={draft.hours} onChange={(e) => set('hours', e.target.value)} error={errors.hours}>
                    {Array.from({ length: service.maxHours - service.minHours + 1 }, (_, i) => service.minHours + i).map((h) => (
                      <option key={h} value={h}>{h} hours</option>
                    ))}
                  </SelectField>
                )}
              </div>
              <p className="small muted">
                <Link to="#" className="link-btn" onClick={(e) => { e.preventDefault(); setStep(0); }}>Change service</Link> ({service?.label})
              </p>
            </div>
          )}

          {step === 2 && quote && (
            <div className="stack">
              <div className="option-grid" style={{ gridTemplateColumns: '1fr' }}>
                {quote.sizes.map((s) => {
                  const disabled = !s.fitsPassengers || s.available === 0;
                  const reason = !s.fitsPassengers ? `Too small for ${draft.passengers} passengers` : s.available === 0 ? 'Fully booked at this time' : s.available <= 2 ? `Only ${s.available} left` : '';
                  return (
                    <button key={s.code} type="button" disabled={disabled} className={`option ${draft.sizeCode === s.code ? 'selected' : ''}`}
                      aria-pressed={draft.sizeCode === s.code} onClick={() => { set('sizeCode', s.code); setError(''); }}>
                      <span className="o-icon"><Icon name="car" /></span>
                      <span className="grow">
                        <div className="o-title">{s.label}</div>
                        <div className="o-sub">{reason || 'Available'}</div>
                      </span>
                      <span style={{ textAlign: 'right' }}>
                        {s.price.discountOnline > 0 && <div className="strike small">{money(s.price.full)}</div>}
                        <div className="strong" style={{ fontSize: 18 }}>{money(s.price.total)}</div>
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="tiny">
                About {quote.distanceMiles} miles{quote.distanceSource === 'estimate' ? ' (estimated from the addresses you typed)' : ''}, {quote.durationMinutes} minutes.
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
                {service.isHourly && <Kv k="Hire length" v={`${draft.hours} hours`} />}
                <Kv k="When" v={fmtDateTime(pickupIso())} />
                <Kv k="Passengers" v={draft.passengers} />
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
                    We will text <strong>{user?.phone || 'the telephone number on your account'}</strong>.{' '}
                    {user ? <Link to="/account" className="strong">Wrong number? Update your profile.</Link> : 'Log in to check which number we have.'}
                  </Alert>
                )}
              </div>

              <div className="card stack">
                <h3>Price</h3>
                <PriceBreakdown price={size.price} discountPct={quote.onlineDiscountPct} />
              </div>

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
                <button className="btn btn-lg btn-block" onClick={() => { setError(''); setStep(4); }}>
                  Continue to payment - {money(size.price.total)}
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

          {step === 4 && size && user?.role === 'customer' && (
            <div className="stack">
              <PaymentStep
                amount={size.price.total}
                paypal={draft.paypalToken ? { token: draft.paypalToken, payer: draft.paypalPayer } : null}
                onPayPal={startPayPal}
                onSubmit={confirm}
                busy={busy}
                serverErrors={payErrors}
                submitLabel={`Pay ${money(size.price.total)} and confirm booking`}
              />
              <div><button className="btn btn-subtle" onClick={() => { setError(''); setStep(3); }}>Back to review</button></div>
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
