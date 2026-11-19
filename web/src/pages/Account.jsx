import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import ProfileForm from '../components/ProfileForm.jsx';
import { Alert, Empty, Loading, Modal, PageHeader, TextField, useLoad, useToast } from '../ui.jsx';
import CardForm, { BLANK_CARD } from '../components/CardForm.jsx';
import { Icon } from '../icons.jsx';
import { onlyDigits, parseExpiry, validateCardForm } from '../validators.js';
import { v, validate } from '../validators.js';

function PasswordForm() {
  const toast = useToast();
  const [f, setF] = useState({ currentPassword: '', newPassword: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setFormError('');
    const errs = validate(f, { currentPassword: (x) => (x ? '' : 'Current password is required'), newPassword: v.password });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api.post('/auth/change-password', f);
      toast('Password changed', 'success');
      setF({ currentPassword: '', newPassword: '' });
    } catch (err) {
      setErrors(err.fields || {});
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {formError && !Object.keys(errors).length && <Alert tone="error">{formError}</Alert>}
      <div className="form-grid two">
        <TextField label="Current password" type="password" autoComplete="current-password" value={f.currentPassword}
          onChange={(e) => setF({ ...f, currentPassword: e.target.value })} error={errors.currentPassword} />
        <TextField label="New password" type="password" autoComplete="new-password" value={f.newPassword}
          onChange={(e) => setF({ ...f, newPassword: e.target.value })} error={errors.newPassword} hint="At least 8 characters with a letter and a number" />
      </div>
      <div><button className="btn btn-secondary" disabled={busy}>{busy ? 'Saving...' : 'Change password'}</button></div>
    </form>
  );
}

function SavedCards() {
  const toast = useToast();
  const { data, loading, reload } = useLoad(() => api.get('/payments/cards'));
  const [adding, setAdding] = useState(false);
  const [card, setCard] = useState(BLANK_CARD);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setFormError('');
    const errs = validateCardForm(card);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const { expMonth, expYear } = parseExpiry(card.expiry);
    setBusy(true);
    try {
      await api.post('/payments/cards', { number: onlyDigits(card.number), expMonth, expYear, cvv: card.cvv, holder: card.holder.trim() });
      toast('Card saved', 'success');
      setAdding(false);
      setCard(BLANK_CARD);
      reload();
    } catch (err) {
      const f = {};
      for (const [k, m] of Object.entries(err.fields || {})) f[k.replace('expYear', 'expiry').replace('expMonth', 'expiry')] = m;
      setErrors(f);
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (c) => {
    await api.del(`/payments/cards/${c.id}`);
    toast(`${c.brandLabel} ending ${c.last4} removed`, 'success');
    reload();
  };

  return (
    <section className="card stack" id="cards">
      <div className="row-between">
        <h3>Saved cards</h3>
        <button className="btn btn-subtle btn-sm" onClick={() => { setAdding(true); setErrors({}); setFormError(''); }}><Icon name="plus" size={16} /> Add card</button>
      </div>
      <p className="muted small">We only keep the last 4 digits and the expiry date. Your full card number and security code are never stored.</p>
      {loading && <Loading />}
      {data && data.cards.length === 0 && <Empty icon="card" title="No saved cards">Save a card while paying, or add one here.</Empty>}
      {data?.cards.map((c) => (
        <div key={c.id} className="list-item">
          <div className="row" style={{ gap: 12 }}>
            <span className="avatar"><Icon name="card" size={16} /></span>
            <div>
              <div className="strong">{c.brandLabel} ending {c.last4}</div>
              <div className="small muted">{c.holder} &middot; {c.expired ? 'Expired' : `Expires ${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}`}</div>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => remove(c)} aria-label={`Delete ${c.brandLabel} ending ${c.last4}`}><Icon name="trash" size={16} /> Delete</button>
        </div>
      ))}
      {adding && (
        <Modal title="Add a card" onClose={() => setAdding(false)}>
          <form className="stack" onSubmit={save} noValidate>
            {formError && !Object.keys(errors).length && <Alert tone="error">{formError}</Alert>}
            <CardForm value={card} onChange={setCard} errors={errors} />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-subtle" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn" disabled={busy}>{busy ? 'Saving...' : 'Save card'}</button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

export default function Account() {
  const { user, setUser } = useAuth();
  const toast = useToast();
  return (
    <div className="container page">
      <div className="medium stack-lg">
        <PageHeader title="Your account" sub="Keep your details up to date so drivers and staff can reach you." />
        <section className="card stack">
          <h3>Personal details</h3>
          <ProfileForm
            initial={user}
            submitLabel="Save changes"
            onSubmit={async (values) => {
              const r = await api.patch('/auth/me', values);
              setUser(r.user);
              toast('Details saved', 'success');
            }}
          />
        </section>
        <SavedCards />
        <section className="card stack">
          <h3>Security</h3>
          <PasswordForm />
        </section>
      </div>
    </div>
  );
}
