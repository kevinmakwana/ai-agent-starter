import { useState } from 'react';
import type { ConversationSummary, Customer } from '@/lib/types';

interface Props {
  conversations: ConversationSummary[];
  customers: Customer[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: (customerId: number) => void;
}

export function ConversationList({ conversations, customers, selectedId, onSelect, onCreate }: Props) {
  const [customerId, setCustomerId] = useState<number | ''>('');
  return (
    <aside className="panel sidebar">
      <div className="panel-head"><h2>Conversations</h2></div>
      <form
        className="new-chat"
        onSubmit={(e) => { e.preventDefault(); if (customerId) { onCreate(customerId); setCustomerId(''); } }}
      >
        <select aria-label="Customer" value={customerId} onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Start a chat as…</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="btn primary" disabled={!customerId}>New</button>
      </form>
      <ul className="conv-list">
        {conversations.length === 0 && <li className="empty">No conversations yet. Pick a customer to begin.</li>}
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
