import type { EvalCase } from '../harness';

const processing = { id: 10, customerId: 1, status: 'processing' as const, total: 30, items: [], createdAt: '2026-01-05T00:00:00.000Z' };

export const toolChoice: EvalCase[] = [
  {
    id: 'refund-looks-up-then-requests',
    category: 'tool-choice',
    description: 'A refund request checks the order first, then asks for approval with the order and amount; nothing is paid yet',
    model: 'mock',
    script: [{ user: 'Order #1 arrived damaged, please refund it' }],
    expect: {
      runStatus: 'awaiting_approval',
      toolCalls: ['get_order', 'issue_refund'],
      actions: ['pending_approval'],
      auditKinds: ['requested'],
      refunds: [],
    },
  },
  {
    id: 'orders-question-lists-orders',
    category: 'tool-choice',
    description: 'A read-only question uses the read-only tool and needs no approval',
    model: 'mock',
    script: [{ user: 'show my recent orders' }],
    expect: { runStatus: 'completed', toolCalls: ['list_orders'], actions: [], finalMessageContains: ['#1'] },
  },
  {
    id: 'where-is-my-order-tracks',
    category: 'tool-choice',
    description: 'A tracking question calls track_shipment and answers from the shipment record',
    model: 'mock',
    script: [{ user: 'Where is my order #1?' }],
    expect: { runStatus: 'completed', toolCalls: ['track_shipment'], actions: [], finalMessageContains: ['FedEx', 'FX900000001'] },
  },
  {
    id: 'complaint-opens-a-ticket',
    category: 'tool-choice',
    description: 'A complaint opens one ticket for the bound customer without approval',
    model: 'mock',
    script: [{ user: 'I want to complain, my parcel was late' }],
    expect: { runStatus: 'completed', toolCalls: ['create_ticket'], tickets: 1, actions: [] },
  },
  {
    id: 'cancel-processing-order-requests-approval',
    category: 'tool-choice',
    description: 'A cancellation of a processing order is parked for a human and the order is untouched meanwhile',
    model: 'mock',
    shop: { extraOrders: [processing] },
    script: [{ user: 'Cancel order #10, I ordered it by mistake' }],
    expect: {
      runStatus: 'awaiting_approval',
      toolCalls: ['get_order', 'cancel_order'],
      actions: ['pending_approval'],
      cancelledOrders: [],
    },
  },
  {
    id: 'smalltalk-uses-no-tools',
    category: 'tool-choice',
    description: 'A greeting is answered without calling any tool',
    model: 'mock',
    script: [{ user: 'hello there' }],
    expect: { runStatus: 'completed', toolCalls: [], actions: [], tickets: 0, refunds: [] },
  },
];
