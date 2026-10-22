import type { PolicyDetail } from './types';

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Human wording for an approval-policy rule; null when there is nothing useful to say.
 * The policy compares (already refunded + this refund) to the threshold and auto-approves only when that total is strictly under it.
 */
export function describeRule(rule: string | null, detail: PolicyDetail | null): string | null {
  const { threshold, priorRefunded, amount } = detail ?? {};
  const full = threshold != null && priorRefunded != null && amount != null;
  switch (rule) {
    case 'always_review': return 'Every refund needs review';
    case 'over_threshold':
      return full
        ? `Refunds on this order would total ${usd(priorRefunded + amount)} (${usd(amount)} now + ${usd(priorRefunded)} already refunded), at or over the ${usd(threshold)} auto-approve limit`
        : 'At or over the auto-approve limit';
    case 'under_threshold':
      return full
        ? `Refunds on this order would total ${usd(priorRefunded + amount)}, under the ${usd(threshold)} auto-approve limit`
        : 'Under the auto-approve limit';
    default: return null;
  }
}
