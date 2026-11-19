import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import ProfileForm from '../components/ProfileForm.jsx';
import { Alert, PageHeader, TextField, useToast } from '../ui.jsx';
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
        <section className="card stack" id="cards">
          <h3>Security</h3>
          <PasswordForm />
        </section>
      </div>
    </div>
  );
}
