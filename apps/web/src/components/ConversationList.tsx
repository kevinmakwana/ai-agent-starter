import { useState } from 'react';
import type { ConversationSummary, Customer } from '@/lib/types';

interface Props {
  conversations: ConversationSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Provide both to show the "new chat" form (customer page). Omit for the read-only reviewer list. */
  /** `null` while the directory is still loading; `[]` when it can't be listed (then an email is asked for). */
  customers?: Customer[] | null;
  onCreate?: (who: { customerId: number } | { email: string }) => void;
  /** Login mode: the customer comes from the session, so there is nothing to pick or type. */
  onNew?: () => void;
}

export function ConversationList({ conversations, customers, selectedId, onSelect, onCreate, onNew }: Props) {
  const [customerId, setCustomerId] = useState<number | ''>('');
  const [email, setEmail] = useState('');
  return (
    <aside className="panel sidebar">
      <div className="panel-head"><h2>Conversations</h2></div>
      {onNew && (
        <div className="new-chat single"><button className="btn primary" onClick={onNew}>New conversation</button></div>
      )}
      {onCreate && (
        <form
          className="new-chat"
          onSubmit={(e) => {
            e.preventDefault();
            if (customers?.length ? customerId : email.trim()) {
              onCreate(customers?.length ? { customerId: customerId as number } : { email: email.trim() });
              setCustomerId(''); setEmail('');
            }
          }}
        >
          {customers === null ? (
            <select aria-label="Loading customers" disabled><option>Loading…</option></select>
          ) : customers?.length ? (
            <select aria-label="Customer" value={customerId} onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Start a chat as…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : (
            <input type="email" aria-label="Your account email" placeholder="Your account email" value={email} onChange={(e) => setEmail(e.target.value)} />
          )}
          <button className="btn primary" disabled={customers === null || (customers?.length ? !customerId : !email.trim())}>New</button>
        </form>
      )}
      <ul className="conv-list">
        {conversations.length === 0 && <li className="empty">No conversations yet.</li>}
        {conversations.map((c) => (
          <li key={c.id}>
            <button className={`conv ${c.id === selectedId ? 'active' : ''}`} onClick={() => onSelect(c.id)}>
              <span className="conv-name">{c.customerName}</span>
              <span className="conv-meta">
                {new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {c.pendingApprovals > 0 && <span className="chip warn">⏸ approval</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
