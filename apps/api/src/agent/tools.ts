import Ajv from 'ajv';
import { assertRefundable, assertSameCustomer, refundable } from './guardrails';
import { GuardrailViolation } from './errors';
import type { ShopRepo, ToolSpec } from './types';
import type { ApprovalFacts } from './policy';

export interface ToolContext {
  /** The customer this conversation is bound to. Never taken from model output. */
  customerId: number;
  shop: ShopRepo;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Risky tools are parked as pending_approval actions unless the approval policy auto-approves the call, in which case it runs inline. */
  risky?: boolean;
  /** Policy checks run before a risky call is parked (createRefund re-checks when it executes). Returns what the approval policy should weigh. */
  preflight?: (ctx: ToolContext, args: any) => Promise<ApprovalFacts | void>;
  execute: (ctx: ToolContext, args: any) => Promise<unknown>;
}

/** Bounded by the database's integer column: a larger id must fail validation, not a query. */
const id = { type: 'integer', minimum: 1, maximum: 2_147_483_647 } as const;

async function loadOwnedOrder(ctx: ToolContext, orderId: number) {
  const order = await ctx.shop.getOrder(orderId);
  if (!order) throw new GuardrailViolation('NOT_FOUND', `Order #${orderId} was not found.`);
  assertSameCustomer(ctx.customerId, order.customerId, `Order #${orderId}`);
  return order;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'get_customer',
    description: 'Look up the customer account by email address.',
    inputSchema: {
      type: 'object',
      properties: { email: { type: 'string', pattern: '^[^@\\s]+@[^@\\s]+$' } },
      required: ['email'],
      additionalProperties: false,
    },
    async execute(ctx, { email }: { email: string }) {
      const customer = await ctx.shop.getCustomer(ctx.customerId);
      // Compare against the bound customer instead of querying by email, so other accounts are never probed.
      if (!customer || customer.email.toLowerCase() !== email.toLowerCase()) {
        throw new GuardrailViolation('CROSS_CUSTOMER', 'Access denied: that email is not the customer in this conversation.');
      }
      return { customer };
    },
  },
  {
    name: 'list_orders',
    description: "List all orders (id, status, total, date) for this conversation's customer.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute(ctx) {
      const orders = await ctx.shop.listOrders(ctx.customerId);
      return {
        orders: orders.map((o) => ({ id: o.id, status: o.status, total: o.total, itemCount: o.items.length, createdAt: o.createdAt })),
      };
    },
  },
  {
    name: 'get_order',
    description: 'Get one order with its items and how much has already been refunded.',
    inputSchema: { type: 'object', properties: { orderId: id }, required: ['orderId'], additionalProperties: false },
    async execute(ctx, { orderId }: { orderId: number }) {
      const order = await loadOwnedOrder(ctx, orderId);
      const refundedTotal = await ctx.shop.totalRefunded(orderId);
      return { order, refundedTotal, refundableRemaining: refundable(order.total, refundedTotal) };
    },
  },
  {
    name: 'create_ticket',
    description: "Open a support ticket for this conversation's customer.",
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', minLength: 3, maxLength: 120 },
        body: { type: 'string', minLength: 1, maxLength: 2000 },
      },
      required: ['subject', 'body'],
      additionalProperties: false,
    },
    async execute(ctx, { subject, body }: { subject: string; body: string }) {
      const ticket = await ctx.shop.createTicket({ customerId: ctx.customerId, subject, body });
      return { ticket: { id: ticket.id, status: ticket.status, subject: ticket.subject } };
    },
  },
  {
    name: 'issue_refund',
    description:
      'Request a refund for an order. RISKY: it either issues the refund immediately or queues it for a human reviewer; the result says which. ' +
      'The amount may not exceed the order total minus earlier refunds.',
    risky: true,
    inputSchema: {
      type: 'object',
      properties: {
        orderId: id,
        amount: { type: 'number', exclusiveMinimum: 0 },
        reason: { type: 'string', minLength: 3, maxLength: 300 },
      },
      required: ['orderId', 'amount', 'reason'],
      additionalProperties: false,
    },
    async preflight(ctx, { orderId, amount }: { orderId: number; amount: number }) {
      const order = await loadOwnedOrder(ctx, orderId);
      const priorRefunded = await ctx.shop.totalRefunded(orderId);
      assertRefundable({ amount, orderTotal: order.total, priorRefunded, status: order.status });
      return { priorRefunded };
    },
    async execute(ctx, args: { orderId: number; amount: number; reason: string; actionId?: string }) {
      // createRefund re-runs ownership + amount checks inside a row-locking transaction.
      const { refundId, refundedTotal } = await ctx.shop.createRefund({ customerId: ctx.customerId, ...args });
      return { status: 'refunded', refundId, orderId: args.orderId, amount: args.amount, refundedTotal };
    },
  },
];

export const toolByName = (name: string) => TOOLS.find((t) => t.name === name);

export const toolSpecs = (): ToolSpec[] =>
  TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = new Map(TOOLS.map((t) => [t.name, ajv.compile(t.inputSchema)]));

/** Postgres text and jsonb cannot store NUL, so it must not get past validation (strings and object keys, at any depth). */
function containsNul(v: unknown): boolean {
  if (typeof v === 'string') return v.includes('\u0000');
  if (Array.isArray(v)) return v.some(containsNul);
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => k.includes('\u0000') || containsNul(x));
  return false;
}

/** Validates model-supplied arguments against the tool's JSON schema before anything executes. */
export function validateToolInput(toolName: string, args: unknown): { ok: true } | { ok: false; errors: string[] } {
  const validate = validators.get(toolName);
  if (!validate) return { ok: false, errors: [`Unknown tool "${toolName}"`] };
  if (validate(args)) {
    if (containsNul(args)) return { ok: false, errors: ['(root) must not contain null characters'] };
    return { ok: true };
  }
  return {
    ok: false,
    errors: (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}`.trim()),
  };
}
