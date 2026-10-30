import { describeRule } from '@/lib/policy';
import type { ApprovalEvent } from '@/lib/types';

const usd = (n: number | undefined) => (n == null ? '' : `$${n.toFixed(2)}`);
const KIND: Record<ApprovalEvent['kind'], string> = {
  requested: 'Review requested', auto_approved: 'Auto-approved', first_approval: 'First approval', approved: 'Approved', rejected: 'Rejected', expired: 'Expired',
};
const WHO: Record<ApprovalEvent['actorType'], string> = { reviewer: 'Reviewer', system: 'System', policy: 'Policy' };

const orderSuffix = (id: number | undefined) => (id != null ? ` · order #${id}` : '');
const title = (e: ApprovalEvent) =>
  e.toolName === 'issue_refund' ? `Refund${orderSuffix(e.toolArgs.orderId)}`
  : e.toolName === 'cancel_order' ? `Cancel${orderSuffix(e.toolArgs.orderId)}`
  : e.toolName;

export function AuditLog({ events }: { events: ApprovalEvent[] }) {
  if (events.length === 0) return <div className="empty pad">No approval decisions yet.</div>;
  return (
    <ol className="audit">
      {events.map((e) => {
        const rule = describeRule(e.rule, e.detail);
        return (
          <li key={e.id} className="audit-row">
            <div className="audit-top">
              <span className={`chip ${e.kind}`}>{KIND[e.kind]}</span>
              <time className="muted" dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString()}</time>
            </div>
            <div>
              <b>{title(e)}</b>
              {e.toolArgs.amount != null && <span className="audit-amount"> {usd(e.toolArgs.amount)}</span>}
            </div>
            <div className="muted">
              {e.actorName ?? WHO[e.actorType]}{rule && ` · ${rule}`}{e.note && ` · “${e.note}”`}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
