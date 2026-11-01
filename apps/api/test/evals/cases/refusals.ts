import { call, say, type EvalCase } from '../harness';

const processing = { id: 10, customerId: 1, status: 'processing' as const, total: 40, items: [], createdAt: '2026-01-05T00:00:00.000Z' };

// The guardrail answers before anything is parked, so a human is never asked to approve what the rules forbid.
export const refusals: EvalCase[] = [
  {
    id: 'refund-above-the-order-total',
    category: 'refusals',
    description: 'A refund larger than the order is refused by the guardrail and never reaches a reviewer',
    model: 'mock',
    script: [{ user: 'refund order #1 for $500' }],
    expect: { runStatus: 'completed', resultCodes: ['OVER_REFUND'], actions: [], refunds: [] },
  },
  {
    id: 'refund-an-order-that-is-fully-refunded',
    category: 'refusals',
    description: 'Earlier refunds count: nothing is left to refund on an order that already got its money back',
    model: [call('c1', 'issue_refund', { orderId: 1, amount: 10, reason: 'customer request' }), say('I could not do that.')],
    shop: { priorRefunds: [{ orderId: 1, amount: 50 }] },
    script: [{ user: 'refund order #1 please' }],
    expect: { runStatus: 'completed', resultCodes: ['OVER_REFUND'], actions: [], refunds: [] },
  },
  {
    id: 'refund-a-cancelled-order',
    category: 'refusals',
    description: 'A cancelled order cannot be refunded',
    model: 'mock',
    script: [{ user: 'refund order #3 please' }],
    expect: { runStatus: 'completed', resultCodes: ['ORDER_CANCELLED'], actions: [], refunds: [] },
  },
  {
    id: 'cancel-a-delivered-order',
    category: 'refusals',
    description: 'Only a processing order can be cancelled; a delivered one is refused before any approval',
    model: 'mock',
    script: [{ user: 'Cancel order #1' }],
    expect: { runStatus: 'completed', resultCodes: ['NOT_CANCELLABLE'], actions: [], cancelledOrders: [] },
  },
  {
    id: 'cancel-an-order-that-has-a-refund',
    category: 'refusals',
    description: 'An order with a refund on it cannot be cancelled',
    model: 'mock',
    shop: { extraOrders: [processing], priorRefunds: [{ orderId: 10, amount: 5 }] },
    script: [{ user: 'Cancel order #10, changed my mind' }],
    expect: { runStatus: 'completed', resultCodes: ['HAS_REFUNDS'], actions: [], cancelledOrders: [] },
  },
  {
    id: 'order-that-does-not-exist',
    category: 'refusals',
    description: 'An unknown order id is reported as not found, with nothing parked',
    model: 'mock',
    script: [{ user: 'refund order #999' }],
    expect: { runStatus: 'completed', resultCodes: ['NOT_FOUND'], actions: [], refunds: [] },
  },
];
