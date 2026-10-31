export type OrderStatus = 'processing' | 'shipped' | 'delivered' | 'cancelled';

export interface Customer {
  id: number;
  name: string;
  email: string;
}

export interface OrderItem {
  sku: string;
  name: string;
  qty: number;
  unitPrice: number;
}

export interface Order {
  id: number;
  customerId: number;
  status: OrderStatus;
  total: number;
  items: OrderItem[];
  createdAt: string;
}

export interface Ticket {
  id: number;
  customerId: number;
  subject: string;
  body: string;
  status: string;
}

export interface Conversation {
  id: string;
  customerId: number;
  customerName: string;
  customerEmail: string;
  title: string;
  createdAt: string;
}

export type RunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'step_limit' | 'budget_exceeded';

/** What produced a run. Null on runs created before this was recorded. */
export interface RunMeta {
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
}

export interface Run extends RunMeta {
  id: string;
  conversationId: string;
  status: RunStatus;
  modelCalls: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export type StepRole = 'user' | 'assistant' | 'tool';

/** One row of the trace. An assistant step with `toolName` is a tool call; a `tool` step is its result. */
export interface Step {
  id: number;
  runId: string;
  conversationId: string;
  role: StepRole;
  content: string | null;
  toolName: string | null;
  toolArgs: unknown;
  toolCallId: string | null;
  result: unknown;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Part of inputTokens the provider served from its prompt cache. */
  cachedInputTokens: number | null;
  createdAt: string;
}

export type NewStep = Pick<Step, 'runId' | 'conversationId' | 'role'> &
  Partial<Omit<Step, 'id' | 'createdAt' | 'runId' | 'conversationId' | 'role'>>;

export type ActionStatus = 'pending_approval' | 'approved' | 'rejected';

/** A risky tool call that is parked until a human decides. */
export interface Action {
  id: string;
  runId: string;
  conversationId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
  reasoning: string;
  status: ActionStatus;
  decisionNote: string | null;
  result: unknown;
  createdAt: string;
  decidedAt: string | null;
  /** Distinct reviewers who must approve before the call runs (1, or 2 under the four-eyes policy). Fixed when parked. */
  approvalsRequired: number;
}

export type NewAction = Pick<Action, 'runId' | 'conversationId' | 'toolName' | 'toolArgs' | 'toolCallId' | 'reasoning'> & {
  /** Why a human is needed; becomes the rule and detail of the `requested` audit event. */
  policy?: { rule: string; detail: Record<string, unknown> };
  /** From the approval policy; defaults to 1. */
  approvalsRequired?: 1 | 2;
};

export type ApprovalEventKind = 'requested' | 'auto_approved' | 'first_approval' | 'approved' | 'rejected' | 'expired';
export type ApprovalActorType = 'reviewer' | 'system' | 'policy';

/** One immutable line of the approval audit log. */
export interface ApprovalEvent {
  id: number;
  kind: ApprovalEventKind;
  /** Null for auto-approved calls, which never create an action. */
  actionId: string | null;
  runId: string;
  conversationId: string;
  actorType: ApprovalActorType;
  /** The reviewer's id for decisions made by a signed-in reviewer; null for policy, system, shared-key and demo callers. */
  actorId: string | null;
  /** The reviewer's current name, joined when listing (so it survives deactivation); null when there is no reviewer. */
  actorName: string | null;
  toolName: string;
  /** The call as it was at that moment. */
  toolArgs: Record<string, unknown>;
  rule: string | null;
  detail: Record<string, unknown> | null;
  note: string | null;
  createdAt: string;
}

export type NewApprovalEvent = Pick<ApprovalEvent, 'kind' | 'runId' | 'conversationId' | 'actorType' | 'toolName' | 'toolArgs'> &
  Partial<Pick<ApprovalEvent, 'actionId' | 'actorId' | 'rule' | 'detail' | 'note'>>;

/** What the decision event should say about who decided and how. */
export interface DecisionAudit {
  kind: 'approved' | 'rejected' | 'expired';
  actorType: 'reviewer' | 'system';
  /** The signed-in reviewer who decided, when there is one. */
  actorId?: string;
}

export interface ShipmentEvent {
  at: string;
  location: string;
  description: string;
}

export interface Shipment {
  orderId: number;
  carrier: string;
  trackingNumber: string;
  status: 'label_created' | 'in_transit' | 'out_for_delivery' | 'delivered';
  eta: string | null;
  events: ShipmentEvent[];
}

/** Everything the agent reads/writes about the shop. Implemented by Postgres and (in tests) in memory. */
export interface ShopRepo {
  getCustomer(id: number): Promise<Customer | null>;
  listOrders(customerId: number): Promise<Order[]>;
  getOrder(orderId: number): Promise<Order | null>;
  totalRefunded(orderId: number): Promise<number>;
  createTicket(input: { customerId: number; subject: string; body: string }): Promise<Ticket>;
  /** Atomically re-checks the refund rules against the DB, then records the refund. */
  createRefund(input: {
    customerId: number;
    orderId: number;
    amount: number;
    reason: string;
    actionId?: string;
  }): Promise<{ refundId: number; refundedTotal: number }>;
  getShipment(orderId: number): Promise<Shipment | null>;
  /** Atomically re-checks that the order can still be cancelled, then cancels it; a replay of the same actionId returns the same result. */
  cancelOrder(input: { customerId: number; orderId: number; actionId?: string }): Promise<{ orderId: number; status: 'cancelled' }>;
}

/** Persistence for runs, steps and approvals. */
export interface AgentStore {
  getConversation(id: string): Promise<Conversation | null>;
  /** Starts a run, or throws ConflictError if the conversation already has one running or awaiting approval. */
  createRun(conversationId: string, meta?: Partial<RunMeta>): Promise<Run>;
  getRun(id: string): Promise<Run | null>;
  updateRun(id: string, patch: Partial<Pick<Run, 'status' | 'modelCalls' | 'error'>>): Promise<Run>;
  addStep(step: NewStep): Promise<Step>;
  /** Tokens the model has billed this conversation so far (summed over its steps). */
  conversationUsage(conversationId: string): Promise<{ inputTokens: number; outputTokens: number }>;
  listSteps(conversationId: string): Promise<Step[]>;
  /** Also writes the `requested` audit event, atomically. */
  createAction(action: NewAction): Promise<Action>;
  getAction(id: string): Promise<Action | null>;
  /** Atomic claim: only succeeds while the action is still pending_approval. Writes the decision event in the same transaction. */
  decideAction(id: string, status: 'approved' | 'rejected', note?: string, audit?: DecisionAudit): Promise<Action | null>;
  /**
   * One reviewer's approval of an action that needs two, atomically (the action row is locked). Below the requirement it
   * records the approval and a `first_approval` event and leaves the action pending (`final: false`); the approval that
   * reaches the requirement, counted over active reviewers only, performs the approve transition (`final: true`).
   * Null when the action is not pending. Throws ConflictError `ALREADY_APPROVED_BY_YOU` for a repeat approval.
   */
  approveStep(actionId: string, reviewer: { id: string }, note?: string): Promise<{ action: Action; final: boolean } | null>;
  addApprovalEvent(event: NewApprovalEvent): Promise<ApprovalEvent>;
  /** Newest first. `before` is an event id to page from. */
  listApprovalEvents(filter?: { conversationId?: string; limit?: number; before?: number }): Promise<ApprovalEvent[]>;
  /** Pending approvals created before `cutoff`, oldest first. */
  listPendingActionsOlderThan(cutoff: Date): Promise<Action[]>;
  /** Decided more than a moment ago, yet never completed (no result) while its run still waits: the process died mid-decision. */
  listStrandedActions(decidedBefore: Date): Promise<Action[]>;
  /** Undoes a claim whose execution failed before producing a result, so the reviewer can decide again. */
  reopenAction(id: string): Promise<void>;
  setActionResult(id: string, result: unknown): Promise<void>;
}

// ---- Provider contract ------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant messages that call tools */
  toolCalls?: ToolCall[];
  /** tool messages answer one call */
  toolCallId?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Completion {
  text?: string;
  toolCalls: ToolCall[];
  /** inputTokens counts every prompt token (cached or not); cachedInputTokens is the part served from the provider's cache. */
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
}

export interface ChatProvider {
  readonly name: string;
  /** Model identifier, recorded on each run. */
  readonly model?: string;
  complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<Completion>;
}
