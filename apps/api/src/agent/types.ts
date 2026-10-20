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
}

export type NewAction = Pick<Action, 'runId' | 'conversationId' | 'toolName' | 'toolArgs' | 'toolCallId' | 'reasoning'>;

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
  createAction(action: NewAction): Promise<Action>;
  getAction(id: string): Promise<Action | null>;
  /** Atomic claim: only succeeds while the action is still pending_approval. */
  decideAction(id: string, status: 'approved' | 'rejected', note?: string): Promise<Action | null>;
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
