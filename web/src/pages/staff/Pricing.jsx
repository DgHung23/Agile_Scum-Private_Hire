import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Alert, Loading, PageHeader, TextField, useLoad, useToast } from '../../ui.jsx';

/** ID-76 manage prices, ID-52 surcharges (Manager). Every change is written to the audit log. */
export default function Pricing() {
  const toast = useToast();
  const { data, loading, error, reload } = useLoad(() => api.get('/staff/pricing'));
  const [draft, setDraft] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) setDraft(JSON.parse(JSON.stringify(data)));
  }, [data]);

  if (loading || !draft) return <Loading />;
  if (error) return <Alert tone="error">{error.message}</Alert>;

  const setIn = (list, code, k, v) => setDraft((d) => ({ ...d, [list]: d[list].map((x) => (x.code === code ? { ...x, [k]: v } : x)) }));
  const setSur = (key, v) => setDraft((d) => ({ ...d, surcharges: d.surcharges.map((x) => (x.key === key ? { ...x, value: v } : x)) }));

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      await api.put('/staff/pricing', {
        services: draft.services.map((s) => ({
          code: s.code, baseFare: s.baseFare, perMile: s.perMile, minFare: s.minFare, extraFee: s.extraFee, ...(s.isHourly ? { hourlyRate: s.hourlyRate } : {}),
        })),
        sizes: draft.sizes.map((z) => ({ code: z.code, multiplier: z.multiplier })),
        packages: draft.packages.map((p) => ({ code: p.code, price: p.price })),
        surcharges: Object.fromEntries(draft.surcharges.map((x) => [x.key, x.value])),
      });
      toast('Prices saved. New quotes use them straight away.', 'success');
      reload();
    } catch (e) {
      setErrors(e.fields || {});
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-lg">
      <PageHeader title="Prices" sub="Rates, cab-size multipliers, daily hire packages and surcharges. Existing bookings keep the price they were quoted."
        actions={<button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving...' : 'Save prices'}</button>} />

      <section className="card stack">
        <h3>Services</h3>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Service</th><th>Base fare (£)</th><th>Per mile (£)</th><th>Minimum fare (£)</th><th>Service fee (£)</th></tr></thead>
            <tbody>
              {draft.services.filter((s) => !s.isHourly).map((s) => (
                <tr key={s.code}>
                  <td className="strong">{s.label}</td>
                  {['baseFare', 'perMile', 'minFare', 'extraFee'].map((k) => (
                    <td key={k}><input className="input" style={{ maxWidth: 110 }} type="number" step="0.1" min="0" aria-label={`${s.label} ${k}`} value={s[k]} onChange={(e) => setIn('services', s.code, k, e.target.value)} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-2">
        <section className="card stack">
          <h3>Cab sizes</h3>
          <p className="small muted">The distance part of the fare (and packages) is multiplied by this.</p>
          {draft.sizes.map((z) => (
            <TextField key={z.code} label={z.label} type="number" step="0.05" min="0.5" max="5" value={z.multiplier} onChange={(e) => setIn('sizes', z.code, 'multiplier', e.target.value)} />
          ))}
        </section>
        <section className="card stack">
          <h3>Daily hire packages</h3>
          <p className="small muted">Price for a saloon. Bigger cabs use the size multiplier.</p>
          {draft.packages.map((p) => (
            <TextField key={p.code} label={`${p.label} (£)`} type="number" step="1" min="0" value={p.price} onChange={(e) => setIn('packages', p.code, 'price', e.target.value)} />
          ))}
        </section>
      </div>

      <section className="card stack">
        <h3>Surcharges and minimum fare</h3>
        <div className="form-grid two">
          {draft.surcharges.map((x) => (
            <TextField key={x.key} label={x.description} type="number" step="0.5" min={x.range[0]} max={x.range[1]} value={x.value}
              error={errors[`surcharges.${x.key}`]} hint={`Allowed: ${x.range[0]} to ${x.range[1]}`} onChange={(e) => setSur(x.key, e.target.value)} />
          ))}
        </div>
      </section>
    </div>
  );
}
