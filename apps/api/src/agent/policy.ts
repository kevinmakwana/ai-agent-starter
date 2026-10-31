export interface ApprovalPolicyConfig {
  /** Refunds whose order total (this one plus earlier refunds) stays under this many dollars skip review. 0 = always review. */
  refundAutoApproveUnder: number;
  /** Actions that need two different reviewers. Absent = nothing does. */
  fourEyes?: {
    /** Refunds of strictly more than this many dollars need two approvals. 0 = off. */
    refundOver: number;
    /** Every cancellation needs two approvals. */
    cancellations: boolean;
  };
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
  /** Distinct reviewers who must approve before it runs. Fixed when the action is parked; auto-approved calls need none. */
  approvalsRequired: 1 | 2;
}

const toCents = (n: number) => Math.round(n * 100);
const isMoney = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

const human = (rule: ApprovalRule, detail: Record<string, unknown> = {}): ApprovalDecision => ({ mode: 'human', rule, detail, approvalsRequired: 1 });

function evaluateRefund(args: unknown, facts: ApprovalFacts, config: ApprovalPolicyConfig): ApprovalDecision {
  const threshold = config.refundAutoApproveUnder;
  if (!(threshold > 0)) return human('always_review');

  const amount = (args as { amount?: unknown } | null)?.amount;
  const { priorRefunded } = facts;
  if (!isMoney(amount) || amount === 0 || !isMoney(priorRefunded)) return human('default');

  const detail = { threshold, priorRefunded, amount };
  return toCents(priorRefunded) + toCents(amount) < toCents(threshold)
    ? { mode: 'auto', rule: 'under_threshold', detail, approvalsRequired: 1 }
    : human('over_threshold', detail);
}

/** Two reviewers for a refund strictly over the configured amount (this refund alone, in cents) and, if enabled, every cancellation. */
function approvalsFor(toolName: string, args: unknown, config: ApprovalPolicyConfig): 1 | 2 {
  const eyes = config.fourEyes;
  if (!eyes) return 1;
  if (toolName === 'cancel_order') return eyes.cancellations ? 2 : 1;
  if (toolName !== 'issue_refund' || !(eyes.refundOver > 0)) return 1;
  const amount = (args as { amount?: unknown } | null)?.amount;
  return isMoney(amount) && toCents(amount) > toCents(eyes.refundOver) ? 2 : 1;
}

/**
 * Decides whether a risky tool call needs a human, and how many. Pure, so the rules can be tested without a database.
 * Anything it does not recognise or cannot evaluate goes to one human.
 */
export function evaluateApproval(toolName: string, args: unknown, facts: ApprovalFacts, config: ApprovalPolicyConfig): ApprovalDecision {
  const decision = decide(toolName, args, facts, config);
  if (decision.mode === 'auto') return decision;
  const approvalsRequired = approvalsFor(toolName, args, config);
  return approvalsRequired === 2 ? { ...decision, approvalsRequired, detail: { ...decision.detail, approvalsRequired } } : decision;
}

function decide(toolName: string, args: unknown, facts: ApprovalFacts, config: ApprovalPolicyConfig): ApprovalDecision {
  if (toolName === 'issue_refund') return evaluateRefund(args, facts, config);
  if (toolName === 'cancel_order') return human('tool_requires_review');
  return human('default');
}
