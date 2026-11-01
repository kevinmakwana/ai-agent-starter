import type { EvalCase } from '../harness';

const processing = { id: 10, customerId: 1, status: 'processing' as const, total: 30, items: [], createdAt: '2026-01-05T00:00:00.000Z' };

export const stateTransitions: EvalCase[] = [
  {
    id: 'approve-pays-once-and-finishes-the-run',
    category: 'state-transitions',
    description: 'An approved refund is recorded once against its approval, the run completes, and the customer is told',
    model: 'mock',
    script: [{ user: 'Order #1 arrived damaged, please refund it' }, { decide: 'approve', note: 'looks right' }],
    expect: {
      runStatus: 'completed',
      refunds: [{ orderId: 1, amount: 50 }],
      actions: ['approved'],
      auditKinds: ['requested', 'approved'],
      finalMessageContains: ['approved and issued'],
    },
  },
  {
    id: 'reject-pays-nothing-and-tells-the-customer',
    category: 'state-transitions',
    description: 'A rejection leaves the shop untouched and the run completes with an explanation',
    model: 'mock',
    script: [{ user: 'Order #1 arrived damaged, please refund it' }, { decide: 'reject', note: 'outside policy' }],
    expect: {
      runStatus: 'completed',
      refunds: [],
      actions: ['rejected'],
      auditKinds: ['requested', 'rejected'],
      finalMessageContains: ['declined'],
    },
  },
  {
    id: 'a-second-decision-on-the-same-approval-is-refused',
    category: 'state-transitions',
    description: 'Replaying an approval (double click, retry) gets a conflict and does not refund twice',
    model: 'mock',
    script: [{ user: 'Order #1 arrived damaged, please refund it' }, { decide: 'approve' }, { decide: 'approve' }],
    expect: { errors: ['ConflictError'], refunds: [{ orderId: 1, amount: 50 }], actions: ['approved'] },
  },
  {
    id: 'approve-after-reject-is-refused',
    category: 'state-transitions',
    description: 'A rejected approval cannot be revived by a later approve',
    model: 'mock',
    script: [{ user: 'Order #1 arrived damaged, please refund it' }, { decide: 'reject' }, { decide: 'approve' }],
    expect: { errors: ['ConflictError'], refunds: [], actions: ['rejected'] },
  },
  {
    id: 'approving-a-cancellation-cancels-the-order',
    category: 'state-transitions',
    description: 'An approved cancellation changes the order, and only then',
    model: 'mock',
    shop: { extraOrders: [processing] },
    script: [{ user: 'Cancel order #10, I ordered it by mistake' }, { decide: 'approve' }],
    expect: { runStatus: 'completed', cancelledOrders: [10], actions: ['approved'], finalMessageContains: ['cancelled'] },
  },
  {
    id: 'rejecting-a-cancellation-leaves-the-order-alone',
    category: 'state-transitions',
    description: 'A rejected cancellation does not touch the order',
    model: 'mock',
    shop: { extraOrders: [processing] },
    script: [{ user: 'Cancel order #10, I ordered it by mistake' }, { decide: 'reject' }],
    expect: { runStatus: 'completed', cancelledOrders: [], actions: ['rejected'] },
  },
  {
    id: 'a-new-message-while-an-approval-is-pending-is-refused',
    category: 'state-transitions',
    description: 'One run at a time: a second message gets a conflict and the parked approval is unaffected',
    model: 'mock',
    script: [{ user: 'Order #1 arrived damaged, please refund it' }, { user: 'hurry up please' }],
    expect: { errors: ['ConflictError'], runStatus: 'awaiting_approval', actions: ['pending_approval'], refunds: [] },
  },
  {
    id: 'the-conversation-continues-after-a-rejection',
    category: 'state-transitions',
    description: 'After a decision the conversation accepts the next message normally',
    model: 'mock',
    script: [{ user: 'Order #1 arrived damaged, please refund it' }, { decide: 'reject' }, { user: 'show my recent orders' }],
    expect: { errors: [], runStatus: 'completed', toolCalls: ['get_order', 'issue_refund', 'list_orders'] },
  },
];
