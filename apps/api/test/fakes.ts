import { ConflictError, GuardrailViolation } from '../src/agent/errors';
import { assertCancellable, assertRefundable, assertSameCustomer } from '../src/agent/guardrails';
import type {
  Action, AgentStore, ApprovalEvent, Conversation, Customer, DecisionAudit, NewAction, NewApprovalEvent, NewStep, Order, Run, RunMeta, Shipment, ShopRepo, Step, Ticket,
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
  // An instance copy, so cancelOrder never mutates the shared ORDERS other tests read.
  orders: Order[] = ORDERS.map((o) => ({ ...o }));
  shipments: Shipment[] = [
    {
      orderId: 2, carrier: 'UPS', trackingNumber: '1Z999AA10123456784', status: 'in_transit', eta: '2026-01-06T00:00:00.000Z',
      events: [
        { at: '2026-01-02T09:00:00.000Z', location: 'Reno, NV', description: 'Label created' },
        { at: '2026-01-03T14:30:00.000Z', location: 'Reno, NV', description: 'Picked up by carrier' },
        { at: '2026-01-04T08:15:00.000Z', location: 'Salt Lake City, UT', description: 'In transit' },
      ],
    },
    {
      orderId: 1, carrier: 'FedEx', trackingNumber: 'FX900000001', status: 'delivered', eta: '2026-01-04T00:00:00.000Z',
      events: [
        { at: '2025-12-28T09:00:00.000Z', location: 'Reno, NV', description: 'Label created' },
        { at: '2025-12-30T11:00:00.000Z', location: 'Denver, CO', description: 'In transit' },
        { at: '2026-01-04T16:45:00.000Z', location: 'Front door', description: 'Delivered' },
      ],
    },
  ];
  cancelActions = new Map<number, string>();
  refunds: { id: number; orderId: number; amount: number; reason: string; actionId?: string }[] = [];
  tickets: Ticket[] = [];

  async getCustomer(id: number) { return CUSTOMERS.find((c) => c.id === id) ?? null; }
  async listOrders(customerId: number) { return this.orders.filter((o) => o.customerId === customerId); }
  async getOrder(id: number) { return this.orders.find((o) => o.id === id) ?? null; }
  async totalRefunded(orderId: number) {
    return this.refunds.filter((r) => r.orderId === orderId).reduce((s, r) => s + r.amount, 0);
  }
  async createTicket(input: { customerId: number; subject: string; body: string }) {
    const t = { id: this.tickets.length + 1, status: 'open', ...input };
    this.tickets.push(t);
    return t;
  }
  async createRefund(input: { customerId: number; orderId: number; amount: number; reason: string; actionId?: string }) {
    const order = await this.getOrder(input.orderId);
    if (!order) throw new GuardrailViolation('NOT_FOUND', 'no such order');
    assertSameCustomer(input.customerId, order.customerId, `Order #${order.id}`);
    const done = input.actionId ? this.refunds.find((r) => r.actionId === input.actionId) : undefined;
    if (done) return { refundId: done.id, refundedTotal: await this.totalRefunded(order.id) }; // replay of an approval
    const prior = await this.totalRefunded(order.id);
    assertRefundable({ amount: input.amount, orderTotal: order.total, priorRefunded: prior, status: order.status });
    const refund = { id: this.refunds.length + 1, orderId: order.id, amount: input.amount, reason: input.reason, actionId: input.actionId };
    this.refunds.push(refund);
    return { refundId: refund.id, refundedTotal: prior + input.amount };
  }
  async getShipment(orderId: number) { return this.shipments.find((s) => s.orderId === orderId) ?? null; }
  async cancelOrder(input: { customerId: number; orderId: number; actionId?: string }) {
    const order = await this.getOrder(input.orderId);
    if (!order) throw new GuardrailViolation('NOT_FOUND', 'no such order');
    assertSameCustomer(input.customerId, order.customerId, `Order #${order.id}`);
    if (input.actionId && this.cancelActions.get(order.id) === input.actionId) return { orderId: order.id, status: 'cancelled' as const }; // replay
    assertCancellable({ status: order.status, priorRefunded: await this.totalRefunded(order.id) });
    order.status = 'cancelled';
    if (input.actionId) this.cancelActions.set(order.id, input.actionId);
    return { orderId: order.id, status: 'cancelled' as const };
  }
}

export class MemoryStore implements AgentStore {
  conversations = new Map<string, Conversation>();
  runs = new Map<string, Run>();
  steps: Step[] = [];
  actions = new Map<string, Action>();
  events: ApprovalEvent[] = [];
  /** Four-eyes: who approved which action, and which reviewers still count (deactivating one removes them from here). */
  approvals = new Map<string, string[]>();
  activeReviewers = new Set<string>();
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
  async createAction({ policy, approvalsRequired = 1, ...a }: NewAction) {
    const action: Action = {
      ...a, id: `act-${++this.n}`, status: 'pending_approval', decisionNote: null, result: null, createdAt: '', decidedAt: null, approvalsRequired,
    };
    this.actions.set(action.id, action);
    await this.addApprovalEvent({
      kind: 'requested', actionId: action.id, runId: a.runId, conversationId: a.conversationId, actorType: 'policy',
      toolName: a.toolName, toolArgs: a.toolArgs, rule: policy?.rule, detail: policy?.detail,
    });
    return { ...action };
  }
  async getAction(id: string) { const a = this.actions.get(id); return a ? { ...a } : null; }
  async decideAction(
    id: string, status: 'approved' | 'rejected', note?: string,
    audit: DecisionAudit = { kind: status, actorType: 'reviewer' },
  ) {
    const a = this.actions.get(id);
    if (!a || a.status !== 'pending_approval') return null;
    Object.assign(a, { status, decisionNote: note ?? null, decidedAt: new Date().toISOString() });
    await this.addApprovalEvent({
      kind: audit.kind, actionId: id, runId: a.runId, conversationId: a.conversationId, actorType: audit.actorType,
      actorId: audit.actorId, toolName: a.toolName, toolArgs: a.toolArgs, note,
    });
    return { ...a };
  }
  async approveStep(id: string, reviewer: { id: string }, note?: string) {
    const a = this.actions.get(id);
    if (!a || a.status !== 'pending_approval') return null;
    const given = this.approvals.get(id) ?? [];
    const counted = () => given.filter((r) => this.activeReviewers.has(r)).length;
    const repeat = given.includes(reviewer.id);
    // a repeat is only a retry once the requirement is already met (the action was reopened after a failed execution)
    if (repeat && counted() < a.approvalsRequired) throw new ConflictError('You have already approved this', 'ALREADY_APPROVED_BY_YOU');
    if (!repeat) { given.push(reviewer.id); this.approvals.set(id, given); }
    const base = { actionId: id, runId: a.runId, conversationId: a.conversationId, actorType: 'reviewer' as const, actorId: reviewer.id, toolName: a.toolName, toolArgs: a.toolArgs, note };
    if (counted() < a.approvalsRequired) {
      await this.addApprovalEvent({ ...base, kind: 'first_approval', detail: { given: counted(), required: a.approvalsRequired } });
      return { action: { ...a }, final: false };
    }
    Object.assign(a, { status: 'approved', decisionNote: note ?? null, decidedAt: new Date().toISOString() });
    await this.addApprovalEvent({ ...base, kind: 'approved' });
    return { action: { ...a }, final: true };
  }
  async addApprovalEvent(e: NewApprovalEvent) {
    const event: ApprovalEvent = {
      id: this.events.length + 1, actionId: null, actorId: null, actorName: null, rule: null, detail: null, note: null, createdAt: '',
      ...(Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as object),
    } as ApprovalEvent;
    this.events.push(event);
    return event;
  }
  async listApprovalEvents(filter: { conversationId?: string; limit?: number; before?: number } = {}) {
    return this.events
      .filter((e) => (!filter.conversationId || e.conversationId === filter.conversationId) && (filter.before === undefined || e.id < filter.before))
      .sort((x, y) => y.id - x.id)
      .slice(0, filter.limit ?? 100);
  }
  async listPendingActionsOlderThan(cutoff: Date) {
    return [...this.actions.values()]
      .filter((a) => a.status === 'pending_approval' && Date.parse(a.createdAt) < cutoff.getTime())
      .map((a) => ({ ...a }));
  }
  async listStrandedActions(decidedBefore: Date) {
    return [...this.actions.values()]
      .filter((a) => a.status !== 'pending_approval' && a.result === null && Date.parse(a.decidedAt!) < decidedBefore.getTime()
        && this.runs.get(a.runId)?.status === 'awaiting_approval')
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
