import { ConflictError, GuardrailViolation } from '../src/agent/errors';
import { assertRefundable, assertSameCustomer } from '../src/agent/guardrails';
import type {
  Action, AgentStore, Conversation, Customer, NewAction, NewStep, Order, Run, RunMeta, ShopRepo, Step, Ticket,
} from '../src/agent/types';

export const CUSTOMERS: Customer[] = [
  { id: 1, name: 'Ava Brooks', email: 'ava.brooks@example.com' },
  { id: 2, name: 'Ben Carter', email: 'ben.carter@example.com' },
];

const item = { sku: 'MUG-01', name: 'Acme Ceramic Mug', qty: 1, unitPrice: 50 };
export const ORDERS: Order[] = [
  { id: 1, customerId: 1, status: 'delivered', total: 50, items: [item], createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 2, customerId: 2, status: 'shipped', total: 80, items: [item], createdAt: '2026-01-02T00:00:00.000Z' },
  { id: 3, customerId: 1, status: 'cancelled', total: 20, items: [item], createdAt: '2026-01-03T00:00:00.000Z' },
];

export class MemoryShop implements ShopRepo {
  refunds: { id: number; orderId: number; amount: number; reason: string }[] = [];
  tickets: Ticket[] = [];

  async getCustomer(id: number) { return CUSTOMERS.find((c) => c.id === id) ?? null; }
  async listOrders(customerId: number) { return ORDERS.filter((o) => o.customerId === customerId); }
  async getOrder(id: number) { return ORDERS.find((o) => o.id === id) ?? null; }
  async totalRefunded(orderId: number) {
    return this.refunds.filter((r) => r.orderId === orderId).reduce((s, r) => s + r.amount, 0);
  }
  async createTicket(input: { customerId: number; subject: string; body: string }) {
    const t = { id: this.tickets.length + 1, status: 'open', ...input };
    this.tickets.push(t);
    return t;
  }
  async createRefund(input: { customerId: number; orderId: number; amount: number; reason: string }) {
    const order = await this.getOrder(input.orderId);
    if (!order) throw new GuardrailViolation('NOT_FOUND', 'no such order');
    assertSameCustomer(input.customerId, order.customerId, `Order #${order.id}`);
    const prior = await this.totalRefunded(order.id);
    assertRefundable({ amount: input.amount, orderTotal: order.total, priorRefunded: prior, status: order.status });
    const refund = { id: this.refunds.length + 1, orderId: order.id, amount: input.amount, reason: input.reason };
    this.refunds.push(refund);
    return { refundId: refund.id, refundedTotal: prior + input.amount };
  }
}

export class MemoryStore implements AgentStore {
  conversations = new Map<string, Conversation>();
  runs = new Map<string, Run>();
  steps: Step[] = [];
  actions = new Map<string, Action>();
  private n = 0;

  addConversation(customerId: number): Conversation {
    const c = CUSTOMERS.find((x) => x.id === customerId)!;
    const conv: Conversation = {
      id: `conv-${++this.n}`, customerId, customerName: c.name, customerEmail: c.email, title: 't', createdAt: '',
    };
    this.conversations.set(conv.id, conv);
    return conv;
  }
  async getConversation(id: string) { return this.conversations.get(id) ?? null; }
  async createRun(conversationId: string, meta: Partial<RunMeta> = {}) {
    const busy = [...this.runs.values()].some(
      (r) => r.conversationId === conversationId && (r.status === 'running' || r.status === 'awaiting_approval'),
    );
    if (busy) throw new ConflictError('This conversation already has a run in progress or waiting for approval.');
    const run: Run = {
      id: `run-${++this.n}`, conversationId, status: 'running', modelCalls: 0, error: null, createdAt: '', finishedAt: null,
      provider: meta.provider ?? null, model: meta.model ?? null, promptVersion: meta.promptVersion ?? null,
    };
    this.runs.set(run.id, run);
    return { ...run };
  }
  async getRun(id: string) { const r = this.runs.get(id); return r ? { ...r } : null; }
  async updateRun(id: string, patch: Partial<Pick<Run, 'status' | 'modelCalls' | 'error'>>) {
    const run = { ...this.runs.get(id)!, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    this.runs.set(id, run);
    return { ...run };
  }
  async addStep(s: NewStep) {
    const step: Step = {
      id: this.steps.length + 1, content: null, toolName: null, toolArgs: null, toolCallId: null, result: null,
      latencyMs: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, createdAt: '',
      ...(Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as object),
    } as Step;
    this.steps.push(step);
    return step;
  }
  async listSteps(conversationId: string) { return this.steps.filter((s) => s.conversationId === conversationId); }
  async conversationUsage(conversationId: string) {
    const mine = this.steps.filter((x) => x.conversationId === conversationId);
    return {
      inputTokens: mine.reduce((n, x) => n + (x.inputTokens ?? 0), 0),
      outputTokens: mine.reduce((n, x) => n + (x.outputTokens ?? 0), 0),
    };
  }
  async createAction(a: NewAction) {
    const action: Action = { ...a, id: `act-${++this.n}`, status: 'pending_approval', decisionNote: null, result: null, createdAt: '', decidedAt: null };
    this.actions.set(action.id, action);
    return { ...action };
  }
  async getAction(id: string) { const a = this.actions.get(id); return a ? { ...a } : null; }
  async decideAction(id: string, status: 'approved' | 'rejected', note?: string) {
    const a = this.actions.get(id);
    if (!a || a.status !== 'pending_approval') return null;
    Object.assign(a, { status, decisionNote: note ?? null, decidedAt: 'now' });
    return { ...a };
  }
  async listPendingActionsOlderThan(cutoff: Date) {
    return [...this.actions.values()]
      .filter((a) => a.status === 'pending_approval' && Date.parse(a.createdAt) < cutoff.getTime())
      .map((a) => ({ ...a }));
  }
  async reopenAction(id: string) {
    const a = this.actions.get(id);
    if (a && a.status !== 'pending_approval' && a.result === null) {
      Object.assign(a, { status: 'pending_approval', decisionNote: null, decidedAt: null });
    }
  }
  async setActionResult(id: string, result: unknown) { this.actions.get(id)!.result = result; }
}
