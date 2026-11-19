import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { Icon } from './icons.jsx';
import { STATUS_LABEL, STATUS_TONE } from './format.js';

/* ---------- toasts ---------- */
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((message, tone = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setItems((s) => [...s, { id, message, tone }]);
    setTimeout(() => setItems((s) => s.filter((i) => i.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- modal ---------- */
export function Modal({ title, onClose, children, footer }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="row-between" style={{ marginBottom: 12 }}>
          <h3>{title}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="stack">{children}</div>
        {footer && (
          <div className="row" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** Promise-style confirm dialog */
export function ConfirmModal({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose, busy }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-subtle" onClick={onClose} disabled={busy}>
            Keep it
          </button>
          <button className={`btn ${danger ? 'btn-danger' : ''}`} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working...' : confirmLabel}
          </button>
        </>
      }
    >
      <p className="muted">{message}</p>
    </Modal>
  );
}

/* ---------- form field ---------- */
export function Field({ label, error, hint, children, className = '', htmlFor }) {
  const auto = useId();
  const id = htmlFor || auto;
  return (
    <div className={`field ${error ? 'invalid' : ''} ${className}`}>
      {label && <label htmlFor={id}>{label}</label>}
      {typeof children === 'function' ? children(id) : children}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function TextField({ label, error, hint, className, type = 'text', ...rest }) {
  return (
    <Field label={label} error={error} hint={hint} className={className}>
      {(id) => <input id={id} className="input" type={type} aria-invalid={!!error} {...rest} />}
    </Field>
  );
}

export function SelectField({ label, error, hint, className, children, ...rest }) {
  return (
    <Field label={label} error={error} hint={hint} className={className}>
      {(id) => (
        <select id={id} className="select" aria-invalid={!!error} {...rest}>
          {children}
        </select>
      )}
    </Field>
  );
}

export function TextArea({ label, error, hint, className, ...rest }) {
  return (
    <Field label={label} error={error} hint={hint} className={className}>
      {(id) => <textarea id={id} className="textarea" aria-invalid={!!error} {...rest} />}
    </Field>
  );
}

/* ---------- small pieces ---------- */
export const Spinner = () => <div className="spinner" role="status" aria-label="Loading" />;
export const Loading = () => (
  <div className="loading">
    <Spinner />
  </div>
);

export function StatusBadge({ status }) {
  return <span className={`badge ${STATUS_TONE[status] || ''}`}>{STATUS_LABEL[status] || status}</span>;
}

export function Alert({ tone = 'info', children, icon }) {
  return (
    <div className={`alert ${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <Icon name={icon || (tone === 'error' ? 'alert' : tone === 'success' ? 'check' : 'info')} size={18} />
      <div>{children}</div>
    </div>
  );
}

export function Empty({ icon = 'inbox', title, children, action }) {
  return (
    <div className="empty">
      <Icon name={icon} size={32} />
      <h3 style={{ margin: '12px 0 6px', color: 'var(--ink)' }}>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

export function PageHeader({ title, sub, actions }) {
  return (
    <div className="row-between" style={{ marginBottom: 24, alignItems: 'flex-end' }}>
      <div>
        <h2>{title}</h2>
        {sub && <p className="muted" style={{ marginTop: 6 }}>{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Stars({ value = 0, onChange, size = 22, label }) {
  return (
    <span className="stars" role={onChange ? 'radiogroup' : 'img'} aria-label={label || `${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) =>
        onChange ? (
          <button
            key={n}
            type="button"
            className={`star-btn ${n <= value ? 'on' : ''}`}
            onClick={() => onChange(n)}
            aria-label={`${n} star${n > 1 ? 's' : ''}`}
            aria-checked={n === value}
            role="radio"
          >
            <Icon name="star" size={size} fill={n <= value ? 'currentColor' : 'none'} />
          </button>
        ) : (
          <span key={n} style={{ color: n <= Math.round(value) ? 'var(--ink)' : 'var(--pressed)' }}>
            <Icon name="star" size={size} fill={n <= Math.round(value) ? 'currentColor' : 'none'} />
          </span>
        ),
      )}
    </span>
  );
}

export function Kv({ k, v, cls = '' }) {
  return (
    <div className={`kv ${cls}`}>
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
}

/** Map an ApiError into per-field error strings for forms. */
export const fieldErrors = (err) => (err && err.fields ? err.fields : {});

/** Simple async-load hook: returns {data, error, loading, reload}. */
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fnRef.current();
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState({ data: null, error, loading: false });
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    load();
  }, deps);
  return { ...state, reload: load, setData: (data) => setState((s) => ({ ...s, data })) };
}
