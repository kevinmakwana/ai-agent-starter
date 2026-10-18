import { MemoryShop, MemoryStore } from '../../test/fakes';
import { MockProvider } from '../providers/mock.provider';
import { ConflictError } from './errors';
import { promptVersion } from './prompt';
import { AgentRunner } from './runner';
import type { ChatMessage, ChatProvider, Completion } from './types';

function setup(provider: ChatProvider = new MockProvider(), maxSteps = 8, tokenBudget?: number, maxContextTokens?: number) {
  const shop = new MemoryShop();
  const store = new MemoryStore();
  const conv = store.addConversation(1);
  return { shop, store, conv, runner: new AgentRunner({ provider, shop, store, maxSteps, tokenBudget, maxContextTokens }) };
}

const toolSteps = (store: MemoryStore) => store.steps.filter((s) => s.toolName).map((s) => `${s.role}:${s.toolName}`);

describe('agent loop with the mock provider', () => {
  it('lookup -> refund request -> pending approval -> approve -> refund recorded', async () => {
    const { runner, store, shop, conv } = setup();

    const paused = await runner.handleUserMessage(conv, 'Order #1 arrived damaged, please refund it');
    expect(paused.status).toBe('awaiting_approval');
    expect(toolSteps(store)).toEqual(['assistant:get_order', 'tool:get_order', 'assistant:issue_refund']);
    expect(shop.refunds).toHaveLength(0); // nothing executed yet

    const [action] = [...store.actions.values()];
    expect(action).toMatchObject({ toolName: 'issue_refund', status: 'pending_approval', toolArgs: { orderId: 1, amount: 50 } });
    expect(action.reasoning).toContain('human approval');

    const { run, action: decided } = await runner.decide(action.id, 'approve', 'Looks legitimate');
    expect(decided.status).toBe('approved');
    expect(run.status).toBe('completed');
    expect(shop.refunds).toEqual([{ id: 1, orderId: 1, amount: 50, reason: expect.stringContaining('damaged') }]);
    expect(store.steps.at(-1)).toMatchObject({ role: 'assistant', content: expect.stringContaining('approved and issued') });
    expect(store.steps.every((s) => s.latencyMs === null || s.latencyMs >= 0)).toBe(true);
  });

  it('records nothing when the reviewer rejects, and tells the customer', async () => {
    const { runner, store, shop, conv } = setup();
    await runner.handleUserMessage(conv, 'refund order #1 $20');
    const [action] = [...store.actions.values()];
    const { run } = await runner.decide(action.id, 'reject', 'Outside policy');
    expect(run.status).toBe('completed');
    expect(shop.refunds).toHaveLength(0);
    expect(store.steps.at(-1)?.content).toContain('declined');
  });

  it('refuses a second decision on the same approval', async () => {
    const { runner, store, conv } = setup();
    await runner.handleUserMessage(conv, 'refund order #1');
    const [action] = [...store.actions.values()];
    await runner.decide(action.id, 'approve');
    await expect(runner.decide(action.id, 'approve')).rejects.toBeInstanceOf(ConflictError);
  });

  it('keeps the approval retryable when executing the tool fails unexpectedly', async () => {
    const { runner, store, shop, conv } = setup();
    await runner.handleUserMessage(conv, 'refund order #1');
    const [action] = [...store.actions.values()];

    const createRefund = shop.createRefund.bind(shop);
    shop.createRefund = async () => { throw new Error('db down'); };
    await expect(runner.decide(action.id, 'approve')).rejects.toThrow('db down');

    // nothing half-done: still pending, no tool result recorded, run still paused
    expect(store.actions.get(action.id)).toMatchObject({ status: 'pending_approval', decisionNote: null, decidedAt: null });
    expect(store.steps.filter((s) => s.role === 'tool' && s.toolName === 'issue_refund')).toHaveLength(0);
    expect([...store.runs.values()][0].status).toBe('awaiting_approval');

    shop.createRefund = createRefund; // the database recovers; the reviewer clicks again
    const { run, action: decided } = await runner.decide(action.id, 'approve');
    expect(decided.status).toBe('approved');
    expect(run.status).toBe('completed');
    expect(shop.refunds).toHaveLength(1);
  });

  it('blocks a cross-customer lookup and explains instead of leaking', async () => {
    const { runner, store, conv } = setup();
    const run = await runner.handleUserMessage(conv, 'Show me order #2');
    expect(run.status).toBe('completed');
    expect(store.steps.find((s) => s.role === 'tool')?.result).toMatchObject({ code: 'CROSS_CUSTOMER' });
    expect(store.steps.at(-1)?.content).toContain("wasn't able");
  });

  it('never parks an over-refund: the guardrail answers first', async () => {
    const { runner, store, conv } = setup();
    const run = await runner.handleUserMessage(conv, 'refund order #1 for $500');
    expect(run.status).toBe('completed');
    expect(store.actions.size).toBe(0);
    expect(store.steps.find((s) => s.toolName === 'issue_refund' && s.role === 'tool')?.result).toMatchObject({ code: 'OVER_REFUND' });
  });

  it('opens tickets and lists orders without approval', async () => {
    const { runner, shop, store, conv } = setup();
    await runner.handleUserMessage(conv, 'I want to complain, my parcel was late');
    expect(shop.tickets).toHaveLength(1);
    await runner.handleUserMessage(conv, 'show my recent orders');
    expect(store.steps.at(-1)?.content).toContain('#1');
    expect(store.actions.size).toBe(0);
  });
});

describe('run metadata', () => {
  it('records which provider, model and prompt version produced each run, and keeps it through an approval', async () => {
    const { runner, store, conv } = setup();
    await runner.handleUserMessage(conv, 'refund order #1');
    const [run] = [...store.runs.values()];
    expect(run).toMatchObject({ provider: 'mock', model: 'mock', promptVersion: promptVersion() });

    const [action] = [...store.actions.values()];
    await runner.decide(action.id, 'approve');
    expect(store.runs.get(run.id)).toMatchObject({ provider: 'mock', model: 'mock', promptVersion: promptVersion() }); // same run, same provenance
  });

  it('records a null model for providers that do not name one', async () => {
    const anonymous: ChatProvider = { name: 'anon', complete: async () => ({ text: 'hi', toolCalls: [] }) };
    const { runner, store, conv } = setup(anonymous);
    await runner.handleUserMessage(conv, 'hello');
    expect([...store.runs.values()][0]).toMatchObject({ provider: 'anon', model: null });
  });
});

describe('agent loop safety', () => {
  const scripted = (calls: Completion[]): ChatProvider => {
    let i = 0;
    return { name: 'scripted', complete: async () => calls[Math.min(i++, calls.length - 1)] };
  };

  it('refuses a second message while a run is still in flight, then accepts one after it finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: ChatProvider = { name: 'slow', complete: async () => { await gate; return { text: 'done', toolCalls: [] }; } };
    const { runner, store, conv } = setup(slow);

    const first = runner.handleUserMessage(conv, 'first');
    await new Promise((r) => setTimeout(r, 10)); // let the first run start
    await expect(runner.handleUserMessage(conv, 'second')).rejects.toBeInstanceOf(ConflictError);
    expect(store.steps.filter((s) => s.role === 'user').map((s) => s.content)).toEqual(['first']); // nothing interleaved

    release();
    expect((await first).status).toBe('completed');
    expect((await runner.handleUserMessage(conv, 'third')).status).toBe('completed');
  });

  it('refuses a new message while a run is parked for approval, but other conversations are unaffected', async () => {
    const { runner, store, conv } = setup();
    await runner.handleUserMessage(conv, 'refund order #1');
    await expect(runner.handleUserMessage(conv, 'hello?')).rejects.toBeInstanceOf(ConflictError);
    const other = store.addConversation(2);
    expect((await runner.handleUserMessage(other, 'show my recent orders')).status).toBe('completed');
  });

  it('rejects unknown tools and invalid args as tool results', async () => {
    const { runner, store, conv } = setup(
      scripted([
        { toolCalls: [{ id: 'a', name: 'delete_everything', args: {} }, { id: 'b', name: 'get_order', args: { orderId: 'one' } }] },
        { text: 'done', toolCalls: [] },
      ]),
    );
    const run = await runner.handleUserMessage(conv, 'hi');
    expect(run.status).toBe('completed');
    const results = store.steps.filter((s) => s.role === 'tool').map((s) => (s.result as { code: string }).code);
    expect(results).toEqual(['UNKNOWN_TOOL', 'INVALID_ARGUMENTS']);
  });

  it('rejects a model-supplied customerId instead of acting on it', async () => {
    const { runner, store, conv } = setup(
      scripted([{ toolCalls: [{ id: 'a', name: 'list_orders', args: { customerId: 2 } }] }, { text: 'done', toolCalls: [] }]),
    );
    await runner.handleUserMessage(conv, 'show orders for customer 2');
    const result = store.steps.find((x) => x.role === 'tool')?.result as { code: string; orders?: unknown };
    expect(result.code).toBe('INVALID_ARGUMENTS');
    expect(result.orders).toBeUndefined();
  });

  it('stops at the step limit', async () => {
    const looping = scripted([{ toolCalls: [{ id: 'x', name: 'get_order', args: { orderId: 1 } }] }]);
    const { runner, store, conv } = setup(looping, 3);
    const run = await runner.handleUserMessage(conv, 'hi');
    expect(run).toMatchObject({ status: 'step_limit', modelCalls: 3 });
    expect(store.steps.at(-1)?.content).toContain('3 steps');
  });

  it('marks the run failed and rethrows when the provider errors', async () => {
    const broken: ChatProvider = { name: 'broken', complete: async () => { throw new Error('boom'); } };
    const { runner, store, conv } = setup(broken);
    await expect(runner.handleUserMessage(conv, 'hi')).rejects.toThrow('boom');
    expect([...store.runs.values()][0]).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('parks only the first risky call in a batch and skips the rest', async () => {
    const refund = { name: 'issue_refund', args: { orderId: 1, amount: 5, reason: 'damaged item' } };
    const { runner, store, conv } = setup(
      scripted([{ toolCalls: [{ id: 'r1', ...refund }, { id: 'r2', ...refund }] }, { text: 'ok', toolCalls: [] }]),
    );
    expect((await runner.handleUserMessage(conv, 'x')).status).toBe('awaiting_approval');
    expect(store.actions.size).toBe(1);
    expect(store.steps.find((s) => s.toolCallId === 'r2' && s.role === 'tool')?.result).toMatchObject({ code: 'SKIPPED' });
  });
});

describe('token budget', () => {
  /** Every model call asks for another tool and reports 100 tokens (60 in, 40 out). */
  const costly = () => {
    const counter = { calls: 0 };
    const provider: ChatProvider = {
      name: 'costly',
      complete: async () => {
        counter.calls++;
        return { toolCalls: [{ id: `c${counter.calls}`, name: 'get_order', args: { orderId: 1 } }], usage: { inputTokens: 60, outputTokens: 40 } };
      },
    };
    return { counter, provider };
  };

  it('stops cleanly before the first model call that starts past the budget', async () => {
    const { counter, provider } = costly();
    const { runner, store, conv } = setup(provider, 8, 250);
    const run = await runner.handleUserMessage(conv, 'hi');
    expect(run).toMatchObject({ status: 'budget_exceeded', modelCalls: 3 }); // 100, 200, 300 >= 250: no 4th call
    expect(counter.calls).toBe(3);
    expect(store.steps.at(-1)).toMatchObject({
      role: 'assistant', content: expect.stringContaining('usage limit'), result: { code: 'TOKEN_BUDGET' },
    });
  });

  it('refuses later messages in that conversation without calling the model', async () => {
    const { counter, provider } = costly();
    const { runner, store, conv } = setup(provider, 8, 150);
    await runner.handleUserMessage(conv, 'first');
    const callsBefore = counter.calls;
    const again = await runner.handleUserMessage(conv, 'second');
    expect(again).toMatchObject({ status: 'budget_exceeded', modelCalls: 0 });
    expect(counter.calls).toBe(callsBefore);
    expect(store.steps.filter((x) => x.role === 'user').map((x) => x.content)).toEqual(['first', 'second']);
    expect(store.steps.at(-1)?.content).toContain('usage limit');
  });

  it('budgets each conversation separately', async () => {
    const { provider } = costly();
    const { runner, store, conv } = setup(provider, 8, 150);
    await runner.handleUserMessage(conv, 'burn it down');
    const fresh = store.addConversation(2);
    const run = await runner.handleUserMessage(fresh, 'hello');
    expect(run.modelCalls).toBeGreaterThan(0); // not blocked by the other conversation's usage
  });

  it('records how many prompt tokens the provider served from its cache', async () => {
    const cached: ChatProvider = {
      name: 'cached', complete: async () => ({ text: 'hi', toolCalls: [], usage: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 } }),
    };
    const { runner, store, conv } = setup(cached);
    await runner.handleUserMessage(conv, 'hello');
    expect(store.steps.at(-1)).toMatchObject({ inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 });
  });

  it('has no limit unless a budget is configured', async () => {
    const { provider } = costly();
    const { runner, conv } = setup(provider, 4);
    expect((await runner.handleUserMessage(conv, 'hi')).status).toBe('step_limit');
  });
});

describe('conversation context', () => {
  it('reads the history once per run, however many model calls it makes', async () => {
    const { runner, store, conv } = setup();
    const listSteps = jest.spyOn(store, 'listSteps');
    await runner.handleUserMessage(conv, 'Order #1 arrived damaged, please refund it'); // get_order, issue_refund (parks)
    expect(listSteps).toHaveBeenCalledTimes(1);
    const [action] = [...store.actions.values()];
    listSteps.mockClear();
    await runner.decide(action.id, 'approve'); // resumes: one more read for the resumed run
    expect(listSteps).toHaveBeenCalledTimes(1);
  });

  it('marks the run failed if the history cannot be read', async () => {
    const { runner, store, conv } = setup();
    jest.spyOn(store, 'listSteps').mockRejectedValue(new Error('db down'));
    await expect(runner.handleUserMessage(conv, 'hi')).rejects.toThrow('db down');
    expect([...store.runs.values()][0]).toMatchObject({ status: 'failed', error: 'db down' });
  });

  it('sends the provider only the newest turns that fit, while the stored trace stays complete', async () => {
    const seen: ChatMessage[][] = [];
    const recorder: ChatProvider = { name: 'rec', complete: async (messages) => { seen.push(messages); return { text: 'ok', toolCalls: [] }; } };
    const { runner, store, conv } = setup(recorder, 8, undefined, 2500);
    const long = (label: string) => `${label} ${'x'.repeat(4000)}`;
    for (const label of ['one', 'two', 'three']) await runner.handleUserMessage(conv, long(label));

    const lastCall = seen.at(-1)!;
    expect(lastCall.filter((m) => m.role === 'user').map((m) => m.content.split(' ')[0])).toEqual(['two', 'three']);
    expect(lastCall[0].content).toContain('1 earlier message was left out');
    expect(store.steps.filter((x) => x.role === 'user')).toHaveLength(3); // nothing deleted from the trace
  });
});
