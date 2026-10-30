export interface Customer { id: number; name: string; email: string; orderCount: number; firstOrderId: number | null }

export interface ConversationSummary {
  id: string; customerId: number; customerName: string; customerEmail: string; title: string;
  createdAt: string; lastStatus: string | null; pendingApprovals: number; totalTokens?: number;
}

export type RunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'step_limit' | 'budget_exceeded';

export interface Usage { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number }

export interface Step {
  id: number; runId: string; role: 'user' | 'assistant' | 'tool'; content: string | null;
  toolName: string | null; toolArgs: unknown; toolCallId: string | null; result: any;
  latencyMs: number | null; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; createdAt: string;
}

export interface Run {
  id: string; status: RunStatus; modelCalls: number; error: string | null;
  createdAt: string; finishedAt: string | null; usage: Usage; steps: Step[];
  /** What produced the run; null on runs recorded before this was tracked. */
  provider: string | null; model: string | null; promptVersion: string | null;
}

export interface PolicyDetail { threshold?: number; priorRefunded?: number; amount?: number }

export interface Approval {
  id: string; runId: string; conversationId: string; toolName: string;
  toolArgs: { orderId?: number; amount?: number; reason?: string };
  toolCallId: string; reasoning: string; status: 'pending_approval' | 'approved' | 'rejected';
  decisionNote: string | null; createdAt: string; decidedAt: string | null;
  customerName: string; customerEmail: string; userMessage: string | null;
  orderTotal: number | null; orderRefunded: number;
  /** The order's status right now (e.g. for judging a cancellation); null when the action names no known order. */
  orderStatus?: string | null;
  /** Why a human was needed (from the audit log); null for approvals created before the log existed. Absent in customer views. */
  policyRule?: string | null;
  policyDetail?: PolicyDetail | null;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  runs: Run[];
  approvals: Approval[];
  usage: Usage & { budget: number };
}

export interface ApprovalEvent {
  id: number;
  kind: 'requested' | 'auto_approved' | 'first_approval' | 'approved' | 'rejected' | 'expired';
  actionId: string | null;
  runId: string;
  conversationId: string;
  actorType: 'reviewer' | 'system' | 'policy';
  actorId: string | null;
  toolName: string;
  toolArgs: { orderId?: number; amount?: number; reason?: string };
  rule: string | null;
  detail: PolicyDetail | null;
  note: string | null;
  createdAt: string;
}
