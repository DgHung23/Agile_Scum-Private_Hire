import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { Icon } from '../icons.jsx';
import { fmtDate, fmtDateTime, fmtShort, money } from '../format.js';
import { Alert, Empty, Kv, Loading, Modal, PageHeader, TextField, useLoad, useToast } from '../ui.jsx';
import { v } from '../validators.js';

const pdfUrl = (r, staff) => `/api/v1/${staff ? 'staff/receipts' : 'receipts'}/${r.id}/pdf`;
const SEND_STATUS = { sent: ['green', 'Sent'], failed: ['red', 'Failed'], queued: ['amber', 'Sending'], retrying: ['amber', 'Retrying'] };

/**
 * ID-59 printable receipt (N37 Save as PDF, N38 Send receipt). The print view hides everything but the receipt and
 * reads well in black and white. A refunded booking shows a REFUNDED mark and its credit note; the receipt itself
 * never changes (FR-6.8).
 */
export function ReceiptView({ r, backTo, staff = false, onSent }) {
  const [sending, setSending] = useState(false);
  const [params] = useSearchParams();
  // "Print" from the receipt history opens this page with ?print=1
  useEffect(() => {
    if (params.get('print') === '1') {
      const id = setTimeout(() => window.print(), 400);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [params]);
  const credit = r.kind === 'credit_note';
  return (
    <div className="stack-lg">
      <div className="row-between no-print" style={{ flexWrap: 'wrap', gap: 12 }}>
        {backTo ? <Link to={backTo} className="small strong">&larr; Back</Link> : <span />}
        <div className="row">
          <button className="btn" onClick={() => window.print()}><Icon name="printer" size={18} /> Print</button>
          {r.id && <a className="btn btn-secondary" href={pdfUrl(r, staff)} download><Icon name="file" size={18} /> Save as PDF</a>}
          {r.id && <button className="btn btn-secondary" onClick={() => setSending(true)}><Icon name="mail" size={18} /> Send</button>}
        </div>
      </div>
      <article className="receipt stack-lg" aria-label={credit ? 'Credit note' : 'Receipt'}>
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div>
            <img src="/brand/logo.svg" alt={r.company.name} className="brand-logo" width="158" height="28" style={{ marginBottom: 10 }} />
            <div className="small muted">{r.company.address}<br />{r.company.phone} &middot; {r.company.email}{r.company.vatNo && <><br />VAT {r.company.vatNo}</>}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <h2 style={{ fontSize: 28 }}>{credit ? 'Credit note' : 'Receipt'}</h2>
            <div className="mono small">{r.number || r.receiptNo}</div>
            <div className="small muted">{credit ? 'Refunded' : 'Paid'} {fmtDate(r.createdAt || r.issuedAt)}</div>
            {!credit && r.refunded && <div className="stamp" aria-label="Refunded">REFUNDED</div>}
          </div>
        </div>

        <div className="grid grid-2">
          <div className="stack-sm">
            <div className="label">Billed to</div>
            <div>{r.customer.name}</div>
            <div className="small muted">{r.customer.email}<br />{r.customer.address}</div>
            {r.businessAccount && <div className="small">Company: {r.businessAccount.name}{r.businessAccount.costCentre && ` - cost centre ${r.businessAccount.costCentre}`}</div>}
          </div>
          <div className="stack-sm">
            <div className="label">Booking reference</div>
            <div className="mono strong" style={{ fontSize: 20 }}>{r.booking.ref}</div>
            <div className="small muted">{r.booking.service}{r.booking.package ? ` - ${r.booking.package}` : ''}</div>
          </div>
        </div>

        <div className="stack-sm">
          <div className="label">Journey</div>
          <Kv k="Pickup" v={r.booking.pickup} />
          <Kv k="Destination" v={r.booking.destination} />
          <Kv k="Date and time" v={fmtDateTime(r.booking.pickupAt)} />
          <Kv k="Passengers" v={r.booking.passengers} />
          <Kv k="Cab" v={r.booking.size} />
          {(r.booking.extras || []).map((e) => <Kv key={e} k="Extra (no charge)" v={e} />)}
        </div>

        {!credit && (
          <div className="stack-sm">
            <div className="label">Charges</div>
            {(r.price.lines || []).length ? r.price.lines.map((l, i) => <Kv key={i} k={l.label} v={money(l.amount)} />) : <Kv k="Journey price" v={money(r.price.full)} />}
            {r.price.discountOnline > 0 && <Kv cls="discount" k="Online booking discount (15%)" v={`-${money(r.price.discountOnline)}`} />}
            {r.price.discountOffer > 0 && <Kv cls="discount" k={`Coupon ${r.price.offerCode}`} v={`-${money(r.price.discountOffer)}`} />}
            <Kv cls="total" k="Final cost" v={money(r.price.total)} />
          </div>
        )}

        <div className="stack-sm">
          <div className="label">{credit ? 'Refund' : 'Payment'}</div>
          {r.amount != null ? (
            <>
              <Kv k={credit ? 'Amount refunded' : 'Amount paid'} v={money(r.amount)} />
              {r.payment && <Kv k={credit ? 'Refunded to' : 'Paid with'} v={r.payment.description} />}
              {r.vatIncluded > 0 && <Kv k="Includes VAT at 20%" v={money(r.vatIncluded)} />}
            </>
          ) : (
            <p className="small muted">No payment recorded yet. Cash bookings get a receipt when the driver takes payment.</p>
          )}
          {r.related?.length > 0 && (
            <p className="small">
              {credit ? 'For receipt ' : 'Linked: '}
              {r.related.map((x) => `${x.number} (${x.kind === 'credit_note' ? 'credit note' : 'receipt'}, ${money(x.amount)})`).join('; ')}
            </p>
          )}
        </div>
        <p className="tiny">Thank you for travelling with Private Hire Cars. Keep this {credit ? 'credit note' : 'receipt'} for your records.</p>
      </article>

      {r.sends && (
        <section className="card stack no-print">
          <h3>Sent</h3>
          {r.sends.length === 0 && <p className="small muted">Not sent yet.</p>}
          {r.sends.map((s) => {
            const [tone, label] = SEND_STATUS[s.status] || ['', s.status];
            return (
              <div key={s.id} className="row-between small">
                <span>{fmtShort(s.at)} to <strong>{s.to}</strong> &middot; {s.automatic ? 'automatic' : s.by}</span>
                <span className={`badge ${tone}`} title={s.error || ''}>{label}{s.status === 'failed' ? ` after ${s.attempts} tries` : ''}</span>
              </div>
            );
          })}
        </section>
      )}
      {sending && <SendReceipt r={r} staff={staff} onClose={() => setSending(false)} onSent={() => { setSending(false); onSent?.(); }} />}
    </div>
  );
}

/** N38: send to my own address or another one (for example an accounts department). */
export function SendReceipt({ r, staff, onClose, onSent }) {
  const toast = useToast();
  const [other, setOther] = useState(false);
  const [to, setTo] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (e) => {
    e.preventDefault();
    if (other) {
      const m = v.email(to);
      if (m) return setErr(m);
    }
    setBusy(true);
    try {
      const res = await api.post(`/${staff ? 'staff/receipts' : 'receipts'}/${r.id}/send`, other ? { to: to.trim() } : {});
      toast(`Sending to ${res.to}. The result appears under "Sent".`, 'success');
      onSent();
    } catch (x) {
      setErr(x.fields?.to || x.message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Send receipt" onClose={onClose}>
      <form className="stack" onSubmit={send} noValidate>
        <p className="small muted">We email {r.number} with the PDF attached. You can send it 3 times an hour.</p>
        <label className="check"><input type="radio" name="to" checked={!other} onChange={() => setOther(false)} /><span>To {staff ? "the customer's" : 'my'} email: <strong>{r.customer.email}</strong></span></label>
        <label className="check"><input type="radio" name="to" checked={other} onChange={() => setOther(true)} /><span>To another address</span></label>
        {other && <TextField label="Email address" type="email" value={to} onChange={(e) => { setTo(e.target.value); setErr(''); }} error={err} />}
        {!other && err && <Alert tone="error">{err}</Alert>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-subtle" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy}>{busy ? 'Sending...' : 'Send receipt'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Receipt of one booking (from My trips). */
export default function Receipt() {
  const { id } = useParams();
  const { data, loading, error, reload } = useLoad(() => api.get(`/bookings/${id}/receipt`), [id]);
  return (
    <div className="container page">
      {loading && <Loading />}
      {error && <Alert tone="error">{error.message}</Alert>}
      {data && <ReceiptView r={data.receipt} backTo={`/trips/${id}`} onSent={reload} />}
    </div>
  );
}

/** One receipt or credit note from the history. */
export function ReceiptById() {
  const { rid } = useParams();
  const { data, loading, error, reload } = useLoad(() => api.get(`/receipts/${rid}`), [rid]);
  return (
    <div className="container page">
      {loading && <Loading />}
      {error && <Alert tone="error">{error.message}</Alert>}
      {data && <ReceiptView r={data.receipt} backTo="/receipts" onSent={reload} />}
    </div>
  );
}

/** N39: receipt history, newest first, with date filter, reference search and View / Print / Save / Send on each row. */
export function Receipts({ customerId = null }) {
  const [params, setParams] = useSearchParams();
  const [f, setF] = useState({ from: params.get('from') || '', to: params.get('to') || '', q: params.get('q') || '' });
  const applied = { from: params.get('from') || '', to: params.get('to') || '', q: params.get('q') || '' };
  const base = customerId ? `/staff/customers/${customerId}/receipts` : '/receipts';
  const { data, loading, error, reload } = useLoad(() => api.get(base + qs(applied)), [params.toString(), customerId]);
  const [sendFor, setSendFor] = useState(null);
  const staff = !!customerId;
  const viewUrl = (r) => (staff ? `/staff/receipts/${r.id}` : `/receipts/${r.id}`);
  const openAndPrint = (r) => {
    const w = window.open(`${viewUrl(r)}?print=1`, '_blank');
    if (!w) window.location.href = `${viewUrl(r)}?print=1`;
  };
  return (
    <div className={staff ? 'stack-lg' : 'container page'}>
      <div className={staff ? 'stack-lg' : 'medium stack-lg'}>
        {!staff && <PageHeader title="Receipts" sub="Every receipt and credit note for your bookings, newest first." />}
        <form className="card form-grid four" onSubmit={(e) => { e.preventDefault(); setParams(Object.fromEntries(Object.entries(f).filter(([, x]) => x))); }}>
          <TextField label="From" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          <TextField label="To" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
          <TextField label="Booking reference" placeholder="e.g. PH-7K2M9Q" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value.toUpperCase() })} />
          <div className="row"><button className="btn btn-secondary">Filter</button>{params.toString() && <button type="button" className="btn btn-ghost" onClick={() => { setF({ from: '', to: '', q: '' }); setParams({}); }}>Clear</button>}</div>
        </form>
        {loading && <Loading />}
        {error && <Alert tone="error">{error.message}</Alert>}
        {data && data.receipts.length === 0 && <Empty icon="file" title="No receipts found">Receipts appear here as soon as a payment succeeds.</Empty>}
        <div className="stack">
          {data?.receipts.map((r) => (
            <div key={r.id} className="card stack-sm">
              <div className="row-between" style={{ alignItems: 'flex-start' }}>
                <div>
                  <div className="strong">{r.kind === 'credit_note' ? 'Credit note' : 'Receipt'} <span className="mono">{r.number}</span></div>
                  <div className="small muted">{fmtDate(r.createdAt)} &middot; <span className="mono">{r.ref}</span> &middot; {r.journey}</div>
                  {r.relatedNumber && <div className="tiny">For receipt {r.relatedNumber}</div>}
                  {r.sends > 0 && <div className="tiny">Sent {r.sends} time{r.sends === 1 ? '' : 's'}, last {fmtShort(r.lastSentAt)}</div>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="strong">{r.kind === 'credit_note' ? '-' : ''}{money(r.amount)}</div>
                  <span className={`badge ${r.status === 'Paid' ? 'green' : r.status === 'Refunded' ? 'amber' : ''}`}>{r.status}</span>
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <Link className="btn btn-subtle btn-sm" to={viewUrl(r)}><Icon name="eye" size={16} /> View</Link>
                <button className="btn btn-subtle btn-sm" onClick={() => openAndPrint(r)}><Icon name="printer" size={16} /> Print</button>
                <a className="btn btn-subtle btn-sm" href={pdfUrl(r, staff)} download><Icon name="file" size={16} /> Save as PDF</a>
                <button className="btn btn-subtle btn-sm" onClick={() => setSendFor(r)}><Icon name="mail" size={16} /> Send</button>
              </div>
            </div>
          ))}
        </div>
        {sendFor && (
          <SendReceiptLoader id={sendFor.id} staff={staff} onClose={() => setSendFor(null)} onSent={() => { setSendFor(null); reload(); }} />
        )}
      </div>
    </div>
  );
}

function SendReceiptLoader({ id, staff, onClose, onSent }) {
  const { data } = useLoad(() => api.get(`/${staff ? 'staff/receipts' : 'receipts'}/${id}`), [id]);
  if (!data) return null;
  return <SendReceipt r={data.receipt} staff={staff} onClose={onClose} onSent={onSent} />;
}

/** Staff view of one receipt (after caller verification; logged). */
export function StaffReceipt() {
  const { rid } = useParams();
  const { data, loading, error, reload } = useLoad(() => api.get(`/staff/receipts/${rid}`), [rid]);
  if (loading) return <Loading />;
  if (error) return <Alert tone="error">{error.message}</Alert>;
  return <ReceiptView r={data.receipt} staff backTo="/staff/call-desk" onSent={reload} />;
}
