import type { ChatMessage, ChatProvider, Completion, ToolCall } from '../agent/types';

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const ORDER_ID = /(?:order\s*(?:number|no\.?|id)?\s*#?\s*|#)(\d+)/i;
const AMOUNT = /\$\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars)/i;
const WANTS_REFUND = /\b(refund|money back|reimburse)/i;
// "cancelled"/"canceled" is usually a question about an order, not a request to cancel one.
const WANTS_CANCEL = /\bcancel(?!l?ed\b)/i;
const WANTS_TRACK = /\b(track|tracking|shipment|where(?:'s| is)(?: my)?(?: order| package| parcel)|has (?:it|my order) shipped|delivery status)/i;
const WANTS_TICKET = /\b(ticket|complain|escalat)|speak (?:to|with) (?:a )?(?:human|person|manager)/i;
const WANTS_ORDERS = /\b(my orders|order history|recent orders|list (?:my )?orders|what did i (?:order|buy))/i;

const money = (n: unknown) => `$${Number(n).toFixed(2)}`;
const approxTokens = (s: string) => Math.ceil(s.length / 4);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deterministic, rule-based planner: regexes on the latest user message decide which tools to
 * call, and the tool results already in the turn decide what to do next. No network, no keys.
 */
export class MockProvider implements ChatProvider {
  readonly name = 'mock';
  readonly model = 'mock';

  constructor(private readonly delayMs = 0) {}

  async complete(messages: ChatMessage[]): Promise<Completion> {
    if (this.delayMs) await sleep(this.delayMs);
    const out = plan(messages);
    const input = messages.reduce((n, m) => n + approxTokens(m.content), 0);
    const output = approxTokens(out.text ?? '') + out.toolCalls.length * 20;
    return { ...out, usage: { inputTokens: input, outputTokens: output } };
  }
}

function plan(messages: ChatMessage[]): Completion {
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const text = messages[lastUser]?.content ?? '';
  const turn = messages.slice(lastUser + 1);

  // tool calls already made in this turn, paired with their parsed results
  const results = new Map<string, any>();
  for (const m of turn) if (m.role === 'tool') results.set(m.toolCallId!, safeParse(m.content));
  const done = turn
    .flatMap((m) => m.toolCalls ?? [])
    .map((c) => ({ call: c, result: results.get(c.id) }));
  const last = done[done.length - 1];
  const has = (name: string) => done.some((d) => d.call.name === name);
  const call = (name: string, args: Record<string, unknown>, thought: string): Completion => ({
    text: thought,
    toolCalls: [{ id: `call_${done.length + 1}`, name, args } satisfies ToolCall],
  });
  const say = (t: string): Completion => ({ text: t, toolCalls: [] });

  if (last?.result?.error) return say(`I wasn't able to do that: ${last.result.error}`);

  const orderId = Number(ORDER_ID.exec(text)?.[1]) || undefined;
  const email = EMAIL.exec(text)?.[0];
  const amount = Number(AMOUNT.exec(text)?.slice(1).find(Boolean)) || undefined;

  if (WANTS_REFUND.test(text)) {
    if (!orderId) {
      if (!has('list_orders')) return call('list_orders', {}, 'Which order is this about? Let me pull up your orders.');
      return say(`Which order would you like refunded? ${describeOrders(last!.result)}`);
    }
    if (!has('get_order')) return call('get_order', { orderId }, `I'll check order #${orderId} before requesting a refund.`);
    if (!has('issue_refund')) {
      const { order, refundableRemaining } = last!.result;
      const refund = amount ?? refundableRemaining;
      return call(
        'issue_refund',
        { orderId, amount: refund, reason: text.replace(/\s+/g, ' ').trim().slice(0, 300) },
        `Order #${orderId} is ${order.status} (total ${money(order.total)}). ` +
          `Refunds may need human approval, so I'm submitting a request for ${money(refund)}.`,
      );
    }
    const r = last!.result;
    if (r.status === 'refunded') return say(`Good news: your refund of ${money(r.amount)} for order #${r.orderId} was approved and issued.`);
    return say(`A reviewer declined the refund request for order #${orderId}. ${r.message ?? ''}`.trim());
  }

  if (WANTS_CANCEL.test(text)) {
    if (!orderId) {
      if (!has('list_orders')) return call('list_orders', {}, 'Which order is this about? Let me pull up your orders.');
      return say(`Which order would you like to cancel? ${describeOrders(last!.result)}`);
    }
    if (!has('get_order')) return call('get_order', { orderId }, `I'll check order #${orderId} before requesting a cancellation.`);
    if (!has('cancel_order')) {
      const { order } = last!.result;
      return call(
        'cancel_order',
        { orderId, reason: text.replace(/\s+/g, ' ').trim().slice(0, 300) },
        `Order #${orderId} is ${order.status}. Cancellations are reviewed by a person, so I'm submitting a request.`,
      );
    }
    const r = last!.result;
    if (r.status === 'cancelled') return say(`Order #${r.orderId} has been cancelled.`);
    return say(`A reviewer declined the cancellation of order #${orderId}. ${r.message ?? ''}`.trim());
  }

  if (WANTS_TICKET.test(text)) {
    if (!has('create_ticket')) {
      return call('create_ticket', { subject: text.slice(0, 80).trim() || 'Support request', body: text },
        "I'll open a support ticket so the team can follow up.");
    }
    return say(`I've opened ticket #${last!.result.ticket.id}. Our team will get back to you by email.`);
  }

  if (WANTS_ORDERS.test(text) && !orderId) {
    if (!has('list_orders')) return call('list_orders', {}, 'Let me pull up your orders.');
    return say(`Here are your orders. ${describeOrders(last!.result)}`);
  }

  if (WANTS_TRACK.test(text)) {
    if (!orderId) {
      if (!has('list_orders')) return call('list_orders', {}, 'Which order is this about? Let me pull up your orders.');
      return say(`Which order would you like to track? ${describeOrders(last!.result)}`);
    }
    if (!has('track_shipment')) return call('track_shipment', { orderId }, `Checking the shipment for order #${orderId}.`);
    const r = last!.result;
    if (!r.shipped) {
      // a shipped or delivered order with no shipment row is a data gap, not an order that is still waiting
      if (r.orderStatus === 'shipped' || r.orderStatus === 'delivered') {
        return say(`No tracking information is available for order #${orderId} (it is ${r.orderStatus}).`);
      }
      return say(`Order #${orderId} has not shipped yet (it is ${r.orderStatus}).`);
    }
    const latest = r.events?.at(-1);
    return say(
      `Order #${orderId} shipped with ${r.carrier} (tracking ${r.trackingNumber}): ${r.status}` +
        (r.eta ? `, ETA ${String(r.eta).slice(0, 10)}` : '') + '.' +
        (latest ? ` Latest: ${latest.description} (${latest.location}).` : ''),
    );
  }

  if (orderId) {
    if (!has('get_order')) return call('get_order', { orderId }, `Looking up order #${orderId}.`);
    const { order, refundedTotal } = last!.result;
    const items = order.items.map((i: any) => `${i.qty}× ${i.name}`).join(', ');
    return say(`Order #${order.id} is ${order.status}: ${items}. Total ${money(order.total)}, refunded so far ${money(refundedTotal)}.`);
  }

  if (email) {
    if (!has('get_customer')) return call('get_customer', { email }, `Checking the account for ${email}.`);
    return say(`I found the account for ${last!.result.customer.name}. How can I help?`);
  }

  return say(
    "Hi! I'm the Acme Shop support agent. I can look up your orders, track a shipment, open a ticket, " +
      'or request a refund or a cancellation (a human may review those). ' +
      'Try "Show my recent orders", "Where is my order #1?" or "Refund order #1, it arrived damaged".',
  );
}

function describeOrders(result: any): string {
  const orders: any[] = result?.orders ?? [];
  if (!orders.length) return 'You have no orders yet.';
  return orders.map((o) => `#${o.id} (${o.status}, ${money(o.total)})`).join('; ') + '.';
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}
