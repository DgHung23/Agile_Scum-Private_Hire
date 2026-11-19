import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../icons.jsx';
import { todayLondon } from '../format.js';

export const SERVICE_ICONS = {
  local: 'pin',
  long_distance: 'route',
  airport: 'plane',
  hotel: 'building',
  meet_greet: 'userCheck',
  daily_hire: 'wheel',
};

const SERVICES = [
  { code: 'local', label: 'Local journey', text: 'Door to door across London, any time of day.' },
  { code: 'long_distance', label: 'Long distance', text: 'Comfortable intercity trips at a clear price.' },
  { code: 'airport', label: 'Airport transfer', text: 'Heathrow, Gatwick, City, Stansted and Luton.' },
  { code: 'hotel', label: 'Hotel transfer', text: 'Arrive and leave in style from any London hotel.' },
  { code: 'meet_greet', label: 'Meet & greet', text: 'Your driver meets you inside the arrivals hall.' },
  { code: 'daily_hire', label: 'Driver & car by the day', text: 'A car and driver at your disposal, by the hour.' },
];

const BENEFITS = [
  { icon: 'clock', title: 'Convenience', text: 'Book a minicab anytime, anywhere - from your phone or your desk.' },
  { icon: 'lock', title: 'Privacy', text: 'Book without anyone overhearing. No phone call needed.' },
  { icon: 'zap', title: 'Priority', text: 'Registered online customers are served before phone bookings.' },
  { icon: 'shield', title: 'Improved safety', text: 'We text you the car details as your driver approaches, so you never get in the wrong car.' },
];

const FAQ = [
  ['How much is the online discount?', 'Every booking you make online is 15% cheaper than the same journey booked by phone or in person.'],
  ['Can I cancel or change a booking?', 'Yes. You can cancel or amend a booking yourself up to 24 hours before pickup. After that, call our team.'],
  ['How will I know my driver is nearby?', 'Choose Text updates when you book. About 10 to 15 minutes before arrival we text the registration, colour and make of your car.'],
  ['Which payment methods do you accept?', 'Visa, Mastercard, American Express and PayPal. Card details are checked securely before your booking is confirmed.'],
];

export default function Home() {
  const nav = useNavigate();
  const [f, setF] = useState({ pickup: '', destination: '', date: '', time: '' });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    const p = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    nav(`/book?${p.toString()}`);
  };

  return (
    <>
      <section className="hero">
        <div className="container hero-grid">
          <div className="stack-lg">
            <div className="stack">
              <span className="badge black" style={{ alignSelf: 'flex-start' }}>
                <Icon name="tag" size={14} /> 15% off every online booking
              </span>
              <h1>Go anywhere in London with Private Hire</h1>
              <p className="muted" style={{ fontSize: 18, maxWidth: 520 }}>
                A fast, friendly and reliable minicab service. Book online in under a minute, see the price up front and
                know exactly who is picking you up.
              </p>
            </div>
            <div className="row">
              <Link to="/book" className="btn btn-lg">
                Book a ride
              </Link>
              <Link to="/services" className="btn btn-lg btn-subtle">
                See services
              </Link>
            </div>
          </div>

          <form className="hero-card stack" onSubmit={submit} aria-label="Quick price request">
            <h3>Request a ride</h3>
            <div className="field">
              <label htmlFor="h-pickup" className="sr-only">Pickup location</label>
              <input id="h-pickup" className="input" placeholder="Pickup location" value={f.pickup} onChange={set('pickup')} autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="h-dest" className="sr-only">Destination</label>
              <input id="h-dest" className="input" placeholder="Destination" value={f.destination} onChange={set('destination')} autoComplete="off" />
            </div>
            <div className="form-grid two">
              <div className="field">
                <label htmlFor="h-date" className="sr-only">Date</label>
                <input id="h-date" className="input" type="date" min={todayLondon()} value={f.date} onChange={set('date')} />
              </div>
              <div className="field">
                <label htmlFor="h-time" className="sr-only">Time</label>
                <input id="h-time" className="input" type="time" value={f.time} onChange={set('time')} />
              </div>
            </div>
            <button className="btn btn-lg btn-block" type="submit" style={{ borderRadius: 16 }}>
              See prices
            </button>
            <p className="tiny center">Log in or sign up on the next step to confirm your booking.</p>
          </form>
        </div>
      </section>

      <section className="container" aria-label="Services">
        <div className="scroll-x" role="list">
          {SERVICES.map((s) => (
            <Link key={s.code} to={`/book?service=${s.code}`} className="chip" role="listitem">
              <Icon name={SERVICE_ICONS[s.code]} size={16} /> {s.label}
            </Link>
          ))}
        </div>
      </section>

      <section className="section container">
        <div className="stack-lg">
          <h2>Why book online?</h2>
          <div className="grid grid-4">
            {BENEFITS.map((b) => (
              <div className="benefit" key={b.title}>
                <div className="b-icon">
                  <Icon name={b.icon} />
                </div>
                <h4>{b.title}</h4>
                <p className="muted small">{b.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section container">
        <div className="stack-lg">
          <div className="row-between">
            <h2>Every kind of journey</h2>
            <Link to="/services" className="btn btn-subtle btn-sm">
              All services <Icon name="arrow" size={16} />
            </Link>
          </div>
          <div className="grid grid-3">
            {SERVICES.map((s) => (
              <Link key={s.code} to={`/book?service=${s.code}`} className="card card-soft clickable service-card">
                <Icon name={SERVICE_ICONS[s.code]} size={28} />
                <h3>{s.label}</h3>
                <p className="muted small">{s.text}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="band-dark">
        <div className="container grid grid-2" style={{ alignItems: 'center', gap: 32 }}>
          <div className="stack">
            <h2>Create an account. Save 15% every time.</h2>
            <p className="muted" style={{ fontSize: 18 }}>
              Registered online customers get 15% off every journey, priority service, saved payment details and
              special offers chosen for the way you travel.
            </p>
          </div>
          <div className="row" style={{ justifyContent: 'flex-start' }}>
            <Link to="/register" className="btn btn-light btn-lg">
              Sign up free
            </Link>
            <Link to="/login" className="btn btn-lg" style={{ background: 'transparent', border: '1px solid #fff' }}>
              Log in
            </Link>
          </div>
        </div>
      </section>

      <section className="section container">
        <div className="medium stack-lg">
          <h2>Questions, answered</h2>
          <div className="faq">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
