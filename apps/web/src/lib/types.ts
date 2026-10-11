export interface Customer { id: number; name: string; email: string; orderCount: number; firstOrderId: number | null }

export interface ConversationSummary {
  id: string; customerId: number; customerName: string; customerEmail: string; title: string;
  createdAt: string; lastStatus: string | null; pendingApprovals: number;
}

export type RunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'step_limit';

export interface Step {
  id: number; runId: string; role: 'user' | 'assistant' | 'tool'; content: string | null;
  toolName: string | null; toolArgs: unknown; toolCallId: string | null; result: any;
  latencyMs: number | null; inputTokens: number | null; outputTokens: number | null; createdAt: string;
}

export interface Run {
  id: string; status: RunStatus; modelCalls: number; error: string | null;
  createdAt: string; finishedAt: string | null; steps: Step[];
}

export interface Approval {
  id: string; runId: string; conversationId: string; toolName: string;
  toolArgs: { orderId?: number; amount?: number; reason?: string };
  toolCallId: string; reasoning: string; status: 'pending_approval' | 'approved' | 'rejected';
  decisionNote: string | null; createdAt: string; decidedAt: string | null;
  customerName: string; customerEmail: string; userMessage: string | null;
  orderTotal: number | null; orderRefunded: number;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  runs: Run[];
  approvals: Approval[];
}
