/** Human wording for an approval-policy rule; null when there is nothing useful to say. */
export function describeRule(rule: string | null, detail: { threshold?: number } | null): string | null {
  const limit = detail?.threshold != null ? `$${detail.threshold.toFixed(2)} auto-approve limit` : 'auto-approve limit';
  switch (rule) {
    case 'always_review': return 'Every refund needs review';
    case 'over_threshold': return `Over the ${limit}`;
    case 'under_threshold': return `Under the ${limit}`;
    default: return null;
  }
}
