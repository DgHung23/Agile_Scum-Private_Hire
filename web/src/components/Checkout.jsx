import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { fmtTime, money } from '../format.js';
import { Alert, Modal } from '../ui.jsx';
import PaymentStep from './PaymentStep.jsx';

const BRAND = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express' };

/**
 * Online checkout (report Figure 26): the booking is saved as Pending payment (the cab is held), then
 *  - card: 3D Secure check on a simulated bank screen, then the bank authorises (ID-53, ID-54)
 *  - PayPal / bank: go to the provider and come back (ID-55, ID-57)
 *  - cash to the driver: confirmed at once (ID-56)
 * A failed payment keeps the booking waiting, so the customer can try again without re-entering the journey.
 *
 * Props:
 *   create(payment)   -> first attempt (POST /bookings); later attempts use POST /bookings/:id/pay
 *   pendingId         -> an existing Pending payment booking (retry, or back from PayPal)
 *   onPending(id)     -> remember the waiting booking (so the page can survive a redirect)
 *   onDone(response)  -> paid and confirmed
 *   returnTo          -> where the simulated provider page sends the customer back
 *   redirectResult    -> { token, bookingId, status } when coming back from the provider
 */
export default function Checkout({ amount, create, pendingId: initialPending = null, onPending, onDone, onFieldErrors, returnTo, redirectResult, holdUntil }) {
  const nav = useNavigate();
  const [pendingId, setPendingId] = useState(initialPending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [payErrors, setPayErrors] = useState({});
  const [challenge, setChallenge] = useState(null);
  const [holdTo, setHoldTo] = useState(holdUntil || null);
  const handled = useRef(false);

  const remember = (id) => {
    setPendingId(id);
    onPending?.(id);
  };

  const handle = (r) => {
    if (r.booking?.holdExpiresAt) setHoldTo(r.booking.holdExpiresAt);
    const a = r.nextAction;
    if (!a) return onDone(r);
    remember(a.bookingId);
    if (a.type === '3ds') return setChallenge(a);
    if (a.type === 'redirect') {
      nav(`/pay/provider?token=${encodeURIComponent(a.token)}&return=${encodeURIComponent(returnTo)}`);
    }
  };

  const fail = (err) => {
    if (['hold_expired', 'not_pending'].includes(err.code)) remember(null);
    setError(err.message);
    const f = err.fields || {};
    const payF = Object.fromEntries(Object.entries(f).filter(([k]) => k.startsWith('payment.')));
    if (Object.keys(payF).length) setPayErrors(payF);
    else if (Object.keys(f).length) onFieldErrors?.(err);
    else if (err.code === 'no_availability' || err.code === 'no_availability_return' || err.fields?.offerCode) onFieldErrors?.(err);
  };

  const pay = async (payment) => {
    setBusy(true);
    setError('');
    setPayErrors({});
    try {
      const r = pendingId ? await api.post(`/bookings/${pendingId}/pay`, { payment }) : await create(payment);
      handle(r);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  // Back from PayPal or the bank (simulated).
  useEffect(() => {
    if (!redirectResult || handled.current) return;
    handled.current = true;
    const { token, bookingId, status } = redirectResult;
    remember(bookingId);
    if (status !== 'approved') {
      setError('The payment was cancelled. You have not been charged. Choose a payment method to try again.');
      return;
    }
    setBusy(true);
    api
      .post(`/bookings/${bookingId}/redirect-complete`, { token })
      .then(onDone)
      .catch(fail)
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redirectResult]);

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}
      {pendingId && holdTo && (
        <Alert tone="info" icon="clock">We are holding your cab until {fmtTime(holdTo)} while you pay.</Alert>
      )}
      <PaymentStep amount={amount} onSubmit={pay} busy={busy} serverErrors={payErrors} />
      {challenge && (
        <ThreeDSecure
          challenge={challenge}
          onClose={(msg) => {
            setChallenge(null);
            if (msg) setError(msg);
          }}
          onDone={(r) => {
            setChallenge(null);
            onDone(r);
          }}
        />
      )}
    </div>
  );
}

/** Simulated bank screen for 3D Secure (Strong Customer Authentication). */
function ThreeDSecure({ challenge, onClose, onDone }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setErr('Enter the 6-digit code');
    setBusy(true);
    setErr('');
    try {
      const r = await api.post(`/bookings/${challenge.bookingId}/3ds`, { challengeId: challenge.challengeId, code });
      onDone(r);
    } catch (x) {
      if (x.code === 'sca_wrong_code') {
        setErr(x.message);
        setBusy(false);
      } else onClose(x.message);
    }
  };
  return (
    <Modal title="Confirm it's you" onClose={() => onClose('The bank check was not finished. You have not been charged.')}>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="center stack-sm">
          <span className="badge amber" style={{ alignSelf: 'center' }}>Your bank - simulated 3D Secure check</span>
          <p className="muted small">Approve a payment of <strong>{money(challenge.amount)}</strong> to Private Hire Cars with your {BRAND[challenge.brand] || 'card'} ending {challenge.last4}.</p>
          <p className="small">We sent a one-time code to your phone. For this prototype, the code is <span className="kbd">123456</span>.</p>
        </div>
        <div className="field">
          <label htmlFor="sca-code">One-time code</label>
          <input id="sca-code" className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
            aria-invalid={!!err} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
          {err && <span className="field-error" role="alert">{err}</span>}
        </div>
        <button className="btn btn-lg btn-block" disabled={busy}>{busy ? 'Checking with your bank...' : 'Confirm payment'}</button>
      </form>
    </Modal>
  );
}
