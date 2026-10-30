import { useState } from 'react';
import { describeRule } from '@/lib/policy';
import { approvalProgress, canApprove } from '@/lib/reviewer-auth';
import type { Approval, Reviewer } from '@/lib/types';

const usd = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`);

const orderSuffix = (id: number | undefined) => (id != null ? ` · order #${id}` : '');

function Card({ a, me, onDecide }: { a: Approval; me: Reviewer | null; onDecide: (id: string, d: 'approve' | 'reject', note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (d: 'approve' | 'reject') => { setBusy(true); try { await onDecide(a.id, d, note); } finally { setBusy(false); } };
  const remaining = a.orderTotal == null ? null : a.orderTotal - a.orderRefunded;
  const cancel = a.toolName === 'cancel_order';
  const refund = a.toolName === 'issue_refund';
  const title = refund ? `Refund${orderSuffix(a.toolArgs.orderId)}` : cancel ? `Cancel order · #${a.toolArgs.orderId}` : `${a.toolName}${orderSuffix(a.toolArgs.orderId)}`;
  const why = a.status === 'pending_approval' ? describeRule(a.policyRule ?? null, a.policyDetail ?? null) : null;
  const progress = approvalProgress(a);
  const approval = canApprove(a, me);
  return (
    <article className="approval">
      <div className="approval-top">
        <div><b>{title}</b><div className="muted">{a.customerName} · {a.customerEmail}</div></div>
        {refund && <div className="amount">{usd(a.toolArgs.amount)}</div>}
      </div>
      {why && <div className="chip warn why">{why}</div>}
      {progress && <div className="chip progress">{progress}</div>}
      {cancel ? (
        <dl>
          <dt>Order status</dt><dd>{a.orderStatus ?? '—'}</dd>
          <dt>Order total</dt><dd>{usd(a.orderTotal)}</dd>
          <dt>Already refunded</dt><dd>{usd(a.orderRefunded)}</dd>
        </dl>
      ) : (
        <dl>
          <dt>Order total</dt><dd>{usd(a.orderTotal)}</dd>
          <dt>Already refunded</dt><dd>{usd(a.orderRefunded)}</dd>
          <dt>Refundable now</dt><dd>{usd(remaining)}</dd>
        </dl>
      )}
      {a.userMessage && <blockquote><span>Customer said</span>{a.userMessage}</blockquote>}
      <blockquote className="agent"><span>Agent reasoning</span>{a.reasoning}{a.toolArgs.reason && <em>Reason given: “{a.toolArgs.reason}”</em>}</blockquote>
      {a.status === 'pending_approval' ? (
        <div className="decide">
          <input placeholder="Optional note for the audit log" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Reviewer note" />
          <button className="btn ok" disabled={busy || !approval.allowed} title={approval.reason ?? undefined} onClick={() => decide('approve')}>Approve</button>
          <button className="btn danger" disabled={busy} onClick={() => decide('reject')}>Reject</button>
          {(a.approvalsRequired ?? 1) > 1 && (
            <p className="muted two-eyes">
              {approval.reason ?? 'Needs two different reviewers. Nothing happens until the second approval; one rejection ends it.'}
            </p>
          )}
        </div>
      ) : (
        <div className={`chip ${a.status}`}>{a.status}{a.decisionNote ? ` · ${a.decisionNote}` : ''}</div>
      )}
    </article>
  );
}

export function ApprovalsPanel({ approvals, me, onDecide }: { approvals: Approval[]; me: Reviewer | null; onDecide: (id: string, d: 'approve' | 'reject', note: string) => Promise<void> }) {
  const pending = approvals.filter((a) => a.status === 'pending_approval');
  const decided = approvals.filter((a) => a.status !== 'pending_approval').slice(0, 5);
  return (
    <div className="approvals">
      {pending.length === 0 && <div className="empty pad">Nothing waiting. Ask the agent to refund or cancel an order to see one here.</div>}
      {pending.map((a) => <Card key={a.id} a={a} me={me} onDecide={onDecide} />)}
      {decided.length > 0 && <h3>Recently decided</h3>}
      {decided.map((a) => <Card key={a.id} a={a} me={me} onDecide={onDecide} />)}
    </div>
  );
}
