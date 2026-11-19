import { useState } from 'react';
import { api, qs } from '../../api.js';
import { fmtDateTime, londonToIso, money, todayLondon } from '../../format.js';
import { Alert, Empty, Loading, PageHeader, SelectField, TextField, useLoad } from '../../ui.jsx';

/** US9.4: which cabs and drivers are free at a date/time, with an estimated price for a journey. */
export default function StaffAvailability() {
  const sizes = useLoad(() => api.publicGet('/catalog/cab-sizes'));
  const services = useLoad(() => api.publicGet('/catalog/services'));
  const [f, setF] = useState({ date: todayLondon(), time: '09:00', size: '', serviceCode: '', pickup: '', destination: '', hours: 4, durationMinutes: 60 });
  const [res, setRes] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const service = services.data?.services.find((s) => s.code === f.serviceCode);

  const search = async (e) => {
    e.preventDefault();
    setError('');
    const start = londonToIso(f.date, f.time);
    if (!start) return setError('Choose a date and a time.');
    setBusy(true);
    try {
      setRes(
        await api.get('/staff/availability' + qs({
          start,
          size: f.size,
          durationMinutes: f.serviceCode ? undefined : f.durationMinutes,
          serviceCode: f.serviceCode,
          pickup: f.pickup,
          destination: service?.isHourly ? '' : f.destination,
          hours: service?.isHourly ? f.hours : undefined,
        })),
      );
    } catch (err) {
      setError(err.fields ? Object.values(err.fields)[0] : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-lg">
      <PageHeader title="Availability" sub="See which cabs and drivers are free, and quote an estimated price while the customer is on the phone." />
      <form className="card stack" onSubmit={search}>
        <div className="form-grid two">
          <TextField label="Date" type="date" value={f.date} onChange={set('date')} />
          <TextField label="Time" type="time" step="300" value={f.time} onChange={set('time')} />
          <SelectField label="Cab size" value={f.size} onChange={set('size')}>
            <option value="">Any size</option>
            {sizes.data?.cabSizes.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </SelectField>
          <SelectField label="Journey type (for price estimate)" value={f.serviceCode} onChange={set('serviceCode')}>
            <option value="">No price estimate</option>
            {services.data?.services.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </SelectField>
          {f.serviceCode && (
            <>
              <TextField label="Pickup" value={f.pickup} onChange={set('pickup')} />
              {service?.isHourly ? <TextField label="Hours" type="number" value={f.hours} onChange={set('hours')} /> : <TextField label="Destination" value={f.destination} onChange={set('destination')} />}
            </>
          )}
          {!f.serviceCode && <TextField label="Journey length (minutes)" type="number" min="15" value={f.durationMinutes} onChange={set('durationMinutes')} />}
        </div>
        <div><button className="btn" disabled={busy}>{busy ? 'Searching...' : 'Show availability'}</button></div>
      </form>
      {error && <Alert tone="error">{error}</Alert>}
      {busy && !res && <Loading />}
      {res && (
        <>
          <p className="muted">
            Free for <strong>{fmtDateTime(res.window.start)}</strong> for about {res.durationMinutes} minutes (plus a 20 minute turnaround).
          </p>
          <div className="grid grid-2" style={{ alignItems: 'start' }}>
            <section className="stack">
              <h3>Cabs ({res.cabs.length})</h3>
              {res.cabs.length === 0 && <Empty icon="car" title="No cabs free">Try another time or size.</Empty>}
              {res.cabs.length > 0 && (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Reg</th><th>Cab</th><th>Size</th>{res.cabs[0].estimatedPrice !== null && <th>Estimate</th>}</tr></thead>
                    <tbody>
                      {res.cabs.map((c) => (
                        <tr key={c.id}>
                          <td className="mono strong">{c.reg}</td>
                          <td>{c.colour} {c.make} {c.model}</td>
                          <td>{c.sizeLabel}</td>
                          {c.estimatedPrice !== null && <td className="strong">{money(c.estimatedPrice)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="stack">
              <h3>Drivers ({res.drivers.length})</h3>
              {res.drivers.length === 0 && <Empty icon="wheel" title="No drivers free" />}
              <div className="chips">{res.drivers.map((d) => <span key={d.id} className="chip" style={{ cursor: 'default' }}>{d.fullName}</span>)}</div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
