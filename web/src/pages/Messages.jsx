import { useState } from 'react';
import { api, qs } from '../api.js';
import { Icon } from '../icons.jsx';
import { fmtDateTime } from '../format.js';
import { Alert, Empty, Loading, PageHeader, useLoad } from '../ui.jsx';

/** Renders one simulated email or SMS. */
export function MessageCard({ n, showRecipient }) {
  const [open, setOpen] = useState(false);
  const sms = n.channel === 'sms';
  return (
    <div className="msg">
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          <span className="avatar" style={{ flex: 'none' }}>
            <Icon name={sms ? 'phone' : 'mail'} size={16} />
          </span>
          <div>
            <div className="strong">{sms ? 'Text message' : n.subject}</div>
            <div className="meta" style={{ marginBottom: 0 }}>
              {sms ? 'SMS' : 'Email'} to {n.to}
              {showRecipient && n.recipientName ? ` (${n.recipientName})` : ''} &middot; {fmtDateTime(n.createdAt)}
            </div>
          </div>
        </div>
        {!sms && (
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Hide' : 'Read'}
          </button>
        )}
      </div>
      {sms ? (
        <div className="sms small" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{n.body}</div>
      ) : (
        open && <p className="small muted" style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>{n.body}</p>
      )}
    </div>
  );
}

export default function Messages() {
  const { data, loading, error } = useLoad(() => api.get('/notifications' + qs({ scope: 'mine' })));
  return (
    <div className="container page">
      <div className="medium stack-lg">
        <PageHeader title="Messages" sub="Emails and text messages we have sent you." />
        <Alert tone="info">
          This is a prototype: emails and texts are not delivered to real inboxes. Every message appears here instead, so
          you can see exactly what customers would receive.
        </Alert>
        {loading && <Loading />}
        {error && <Alert tone="error">{error.message}</Alert>}
        {data && data.notifications.length === 0 && (
          <Empty icon="inbox" title="No messages yet">Confirmations and journey updates will appear here.</Empty>
        )}
        <div className="stack">
          {data?.notifications.map((n) => <MessageCard key={n.id} n={n} />)}
        </div>
      </div>
    </div>
  );
}
