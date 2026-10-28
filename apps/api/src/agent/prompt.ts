import { createHash } from 'node:crypto';
import { toolSpecs } from './tools';
import type { Conversation, ToolSpec } from './types';

export const systemPrompt = (c: Pick<Conversation, 'customerName' | 'customerEmail'>) =>
  [
    'You are the customer-support agent for Acme Shop, a fictional online store.',
    `This conversation is bound to ${c.customerName} <${c.customerEmail}>. Tools act on this customer automatically; never pass a customer id.`,
    'Answer only by calling tools; never invent order data. You can only access this one customer.',
    'issue_refund either issues the refund immediately or queues it for a human reviewer; the result says which.',
    'cancel_order queues the cancellation for a human reviewer and works only for orders that are still being processed; use track_shipment for delivery questions.',
    'Look the order up first, then request a refund only when it is justified, and tell the customer what actually happened.',
    'Be brief and friendly.',
  ].join('\n');

/**
 * Short fingerprint of what shapes the model's behaviour besides the model itself: the system prompt template and
 * the tool definitions. Computed, not hand-maintained, so editing either changes it and traces stay comparable.
 */
export function promptVersion(
  tools: ToolSpec[] = toolSpecs(),
  template: string = systemPrompt({ customerName: '{name}', customerEmail: '{email}' }),
): string {
  return createHash('sha256').update(JSON.stringify({ template, tools })).digest('hex').slice(0, 8);
}
