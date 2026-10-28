export interface ApprovalPolicyConfig {
  /** Refunds whose order total (this one plus earlier refunds) stays under this many dollars skip review. 0 = always review. */
  refundAutoApproveUnder: number;
}

/** What `preflight` learned about the world, for the policy to weigh. */
export interface ApprovalFacts {
  priorRefunded?: number;
}

export type ApprovalRule = 'always_review' | 'under_threshold' | 'over_threshold' | 'tool_requires_review' | 'default';

export interface ApprovalDecision {
  mode: 'auto' | 'human';
  rule: ApprovalRule;
  /** The numbers the decision used; stored in the audit log. */
  detail: Record<string, unknown>;
}

const toCents = (n: number) => Math.round(n * 100);
const isMoney = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

const human = (rule: ApprovalRule, detail: Record<string, unknown> = {}): ApprovalDecision => ({ mode: 'human', rule, detail });

function evaluateRefund(args: unknown, facts: ApprovalFacts, config: ApprovalPolicyConfig): ApprovalDecision {
  const threshold = config.refundAutoApproveUnder;
  if (!(threshold > 0)) return human('always_review');

  const amount = (args as { amount?: unknown } | null)?.amount;
  const { priorRefunded } = facts;
  if (!isMoney(amount) || amount === 0 || !isMoney(priorRefunded)) return human('default');

  const detail = { threshold, priorRefunded, amount };
  return toCents(priorRefunded) + toCents(amount) < toCents(threshold)
    ? { mode: 'auto', rule: 'under_threshold', detail }
    : human('over_threshold', detail);
}

/**
 * Decides whether a risky tool call needs a human. Pure, so the rules can be tested without a database.
 * Anything it does not recognise or cannot evaluate goes to a human.
 */
export function evaluateApproval(toolName: string, args: unknown, facts: ApprovalFacts, config: ApprovalPolicyConfig): ApprovalDecision {
  if (toolName === 'issue_refund') return evaluateRefund(args, facts, config);
  if (toolName === 'cancel_order') return human('tool_requires_review');
  return human('default');
}
