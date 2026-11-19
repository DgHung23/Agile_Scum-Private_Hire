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
          onChange={(e) => setF({ ...f, newPassword: e.target.value })} error={errors.newPassword} hint="At least 12 characters with a letter and a number" />
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
        <VerifyBanner />
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
        <SecretWordForm hasOne={user.hasSecretWord} onSaved={() => setUser({ ...user, hasSecretWord: true })} />
        <Favourites />
        <YourData />
      </div>
    </div>
  );
}

/** ID-11: until the address is verified the customer cannot book; offer a new link. */
export function VerifyBanner() {
  const { user } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!user || user.role !== 'customer' || user.emailVerified) return null;
  const resend = async () => {
    setBusy(true);
    try {
      const r = await api.post('/auth/verify-email/resend');
      toast(r.message, 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert tone="warn">
      <div className="row-between" style={{ gap: 12, flexWrap: 'wrap' }}>
        <span>Please verify <strong>{user.email}</strong> before your first booking. The link is in your Messages.</span>
        <button className="btn btn-sm btn-secondary" onClick={resend} disabled={busy}>{busy ? 'Sending...' : 'Send a new link'}</button>
      </div>
    </Alert>
  );
}

/** ID-20: secret word for phone verification (stored hashed, never shown back). */
function SecretWordForm({ hasOne, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState({ secretWord: '', currentPassword: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const errs = validate(f, {
      secretWord: (x) => (x.trim().length >= 4 ? '' : 'Use at least 4 characters'),
      currentPassword: (x) => (x ? '' : 'Current password is required'),
    });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api.put('/auth/me/secret-word', f);
      toast('Secret word saved', 'success');
      setF({ secretWord: '', currentPassword: '' });
      onSaved();
    } catch (err) {
      setErrors(err.fields || {});
      if (!err.fields || !Object.keys(err.fields).length) toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack">
      <h3>Phone booking secret word</h3>
      <p className="muted small">
        {hasOne ? 'You have a secret word. Enter a new one to change it.' : 'Set a word our call centre can ask for when you phone us.'} It never
        appears on receipts or emails.
      </p>
      <form className="form-grid two" onSubmit={submit} noValidate>
        <TextField label="Secret word" autoComplete="off" value={f.secretWord} onChange={(e) => setF({ ...f, secretWord: e.target.value })} error={errors.secretWord} />
        <TextField label="Current password" type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} error={errors.currentPassword} />
        <div className="span-2"><button className="btn btn-secondary" disabled={busy}>{busy ? 'Saving...' : 'Save secret word'}</button></div>
      </form>
    </section>
  );
}

/** ID-22: favourite places, offered as suggestions when booking. */
function Favourites() {
  const toast = useToast();
  const { data, reload } = useLoad(() => api.get('/support/favourites'));
  const [f, setF] = useState({ label: '', address: '' });
  const [errors, setErrors] = useState({});
  const add = async (e) => {
    e.preventDefault();
    try {
      await api.post('/support/favourites', f);
      setF({ label: '', address: '' });
      setErrors({});
      reload();
    } catch (x) {
      setErrors(x.fields || {});
      if (!x.fields) toast(x.message, 'error');
    }
  };
  return (
    <section className="card stack">
      <h3>Favourite places</h3>
      {data?.favourites.map((p) => (
        <div key={p.id} className="row-between small">
          <span><strong>{p.label}</strong> - {p.address}</span>
          <button className="btn btn-ghost btn-sm" onClick={async () => { await api.del(`/support/favourites/${p.id}`); reload(); }}>Remove</button>
        </div>
      ))}
      <form className="form-grid two" onSubmit={add} noValidate>
        <TextField label="Name" placeholder="Home, Work..." value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} error={errors.label} />
        <TextField label="Address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} error={errors.address} />
        <div><button className="btn btn-secondary">Save place</button></div>
      </form>
    </section>
  );
}

/** ID-16: see and download my data, or delete my account. */
function YourData() {
  const [confirm, setConfirm] = useState(false);
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const { logout } = useAuth();
  const del = async () => {
    try {
      await api.post('/support/delete-account', { currentPassword: pw });
      logout();
      window.location.assign('/');
    } catch (x) {
      setErr(x.fields?.currentPassword || x.message);
    }
  };
  return (
    <section className="card stack">
      <h3>Your data</h3>
      <p className="small muted">Download everything we hold about you, or delete your account. We keep anonymous booking records for 12 months, as Transport for London requires.</p>
      <div className="row">
        <a className="btn btn-secondary" href="/api/v1/support/my-data" download>Download my data</a>
        <button className="btn btn-subtle" onClick={() => setConfirm(true)}>Delete my account</button>
      </div>
      {confirm && (
        <Modal title="Delete your account?" onClose={() => setConfirm(false)}>
          <div className="stack">
            <p className="small">This removes your name, contact details, saved cards and places. It cannot be undone.</p>
            <TextField label="Your password" type="password" value={pw} onChange={(e) => { setPw(e.target.value); setErr(''); }} error={err} />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn btn-subtle" onClick={() => setConfirm(false)}>Keep my account</button>
              <button className="btn" onClick={del} disabled={!pw}>Delete account</button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
