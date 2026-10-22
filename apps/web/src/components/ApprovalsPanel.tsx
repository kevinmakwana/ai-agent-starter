import { useState } from 'react';
import { describeRule } from '@/lib/policy';
import type { Approval } from '@/lib/types';

const usd = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`);

function Card({ a, onDecide }: { a: Approval; onDecide: (id: string, d: 'approve' | 'reject', note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (d: 'approve' | 'reject') => { setBusy(true); try { await onDecide(a.id, d, note); } finally { setBusy(false); } };
  const remaining = a.orderTotal == null ? null : a.orderTotal - a.orderRefunded;
  const why = a.status === 'pending_approval' ? describeRule(a.policyRule, a.policyDetail) : null;
  return (
    <article className="approval">
      <div className="approval-top">
        <div><b>Refund · order #{a.toolArgs.orderId}</b><div className="muted">{a.customerName} · {a.customerEmail}</div></div>
        <div className="amount">{usd(a.toolArgs.amount)}</div>
      </div>
      {why && <div className="chip warn">{why}</div>}
      <dl>
        <dt>Order total</dt><dd>{usd(a.orderTotal)}</dd>
        <dt>Already refunded</dt><dd>{usd(a.orderRefunded)}</dd>
        <dt>Refundable now</dt><dd>{usd(remaining)}</dd>
      </dl>
      {a.userMessage && <blockquote><span>Customer said</span>{a.userMessage}</blockquote>}
      <blockquote className="agent"><span>Agent reasoning</span>{a.reasoning}{a.toolArgs.reason && <em>Reason given: “{a.toolArgs.reason}”</em>}</blockquote>
      {a.status === 'pending_approval' ? (
        <div className="decide">
          <input placeholder="Optional note for the audit log" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Reviewer note" />
          <button className="btn ok" disabled={busy} onClick={() => decide('approve')}>Approve</button>
          <button className="btn danger" disabled={busy} onClick={() => decide('reject')}>Reject</button>
        </div>
      ) : (
        <div className={`chip ${a.status}`}>{a.status}{a.decisionNote ? ` · ${a.decisionNote}` : ''}</div>
      )}
    </article>
  );
}

export function ApprovalsPanel({ approvals, onDecide }: { approvals: Approval[]; onDecide: (id: string, d: 'approve' | 'reject', note: string) => Promise<void> }) {
  const pending = approvals.filter((a) => a.status === 'pending_approval');
  const decided = approvals.filter((a) => a.status !== 'pending_approval').slice(0, 5);
  return (
    <div className="approvals">
      {pending.length === 0 && <div className="empty pad">Nothing waiting. Ask the agent for a refund to see one here.</div>}
      {pending.map((a) => <Card key={a.id} a={a} onDecide={onDecide} />)}
      {decided.length > 0 && <h3>Recently decided</h3>}
      {decided.map((a) => <Card key={a.id} a={a} onDecide={onDecide} />)}
    </div>
  );
}
