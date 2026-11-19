import { useState } from 'react';
import { api } from '../api.js';
import { Alert, Stars, TextArea } from '../ui.jsx';

const FIELDS = [
  ['journeyRating', 'Your journey', 'How was the trip overall?'],
  ['cabRating', 'The minicab', 'Cleanliness and comfort'],
  ['driverRating', 'Your driver', 'Driving, manner and punctuality'],
];

/** US7.1: three separate star ratings and a comment for a completed journey. */
export function ReviewForm({ bookingId, onDone }) {
  const [r, setR] = useState({ journeyRating: 0, cabRating: 0, driverRating: 0 });
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const x = {};
    for (const [k, label] of FIELDS) if (!r[k]) x[k] = `Rate ${label.toLowerCase()} from 1 to 5 stars`;
    setErrors(x);
    if (Object.keys(x).length) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/bookings/${bookingId}/review`, { ...r, comment });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {error && <Alert tone="error">{error}</Alert>}
      {FIELDS.map(([k, label, hint]) => (
        <div key={k} className="row-between">
          <div>
            <div className="strong">{label}</div>
            <div className="tiny" style={{ color: errors[k] ? 'var(--danger)' : undefined }}>{errors[k] || hint}</div>
          </div>
          <Stars value={r[k]} onChange={(n) => { setR({ ...r, [k]: n }); setErrors({ ...errors, [k]: '' }); }} label={`${label} rating`} />
        </div>
      ))}
      <TextArea label="Comments (optional)" value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} style={{ minHeight: 90 }} />
      <div><button className="btn" disabled={busy}>{busy ? 'Sending...' : 'Submit review'}</button></div>
    </form>
  );
}

export function ReviewSummary({ review }) {
  return (
    <div className="stack-sm">
      {FIELDS.map(([k, label]) => (
        <div key={k} className="row-between"><span>{label}</span><Stars value={review[k]} size={18} /></div>
      ))}
      {review.comment && <p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>&ldquo;{review.comment}&rdquo;</p>}
    </div>
  );
}
