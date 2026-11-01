import { call, say, type EvalCase } from '../harness';

// Every scripted turn reports 100 input + 20 output tokens (120).
const looping = [call('x', 'get_order', { orderId: 1 })];

export const budget: EvalCase[] = [
  {
    id: 'the-budget-stops-the-model-calls',
    category: 'budget',
    description: 'Once the conversation has used its token budget the loop stops before the next model call',
    model: looping,
    tokenBudget: 200,
    script: [{ user: 'hi' }],
    expect: { runStatus: 'budget_exceeded', modelCalls: 2, resultCodes: ['TOKEN_BUDGET'] },
  },
  {
    id: 'a-spent-conversation-makes-no-further-model-calls',
    category: 'budget',
    description: 'A later message in the same conversation is answered without calling the model again',
    model: looping,
    tokenBudget: 200,
    script: [{ user: 'hi' }, { user: 'are you there?' }],
    expect: { runStatus: 'budget_exceeded', modelCalls: 2 },
  },
  {
    id: 'a-reviewer-decision-still-runs-after-the-budget-is-spent',
    category: 'budget',
    description: 'The approved refund is carried out even though the budget ran out while it waited; then the model is not called again',
    model: [call('c1', 'issue_refund', { orderId: 1, amount: 50, reason: 'damaged' }), say('Your refund was issued.')],
    tokenBudget: 100,
    script: [{ user: 'refund order 1' }, { decide: 'approve' }],
    expect: { refunds: [{ orderId: 1, amount: 50 }], actions: ['approved'], modelCalls: 1 },
  },
];
