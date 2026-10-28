import { MemoryShop, MemoryStore } from '../../test/fakes';
import { MockProvider } from '../providers/mock.provider';
import { ConflictError, UpstreamLlmError } from './errors';
import { promptVersion } from './prompt';
import { AgentRunner } from './runner';
import type { ChatMessage, ChatProvider, Completion } from './types';

function setup(provider: ChatProvider = new MockProvider(), maxSteps = 8, tokenBudget?: number, maxContextTokens?: number) {
  const shop = new MemoryShop();
  const store = new MemoryStore();
  const conv = store.addConversation(1);
  return { shop, store, conv, runner: new AgentRunner({ provider, shop, store, maxSteps, tokenBudget, maxContextTokens }) };
}

const scripted = (calls: Completion[]): ChatProvider => {
  let i = 0;
  return { name: 'scripted', complete: async () => calls[Math.min(i++, calls.length - 1)] };
};

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
    expect(shop.refunds).toEqual([{ id: 1, orderId: 1, amount: 50, reason: expect.stringContaining('damaged'), actionId: action.id }]); // tied to its approval
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

describe('mock provider: cancel and track flows', () => {
  const withProcessing = () => {
    const ctx = setup();
    ctx.shop.orders.push({ id: 10, customerId: 1, status: 'processing', total: 30, items: [], createdAt: '2026-01-05T00:00:00.000Z' });
    return ctx;
  };
  const lastText = (store: MemoryStore) => store.steps.at(-1)?.content;

  it('cancels a processing order: lookup -> cancel_order parks -> approve -> says it was cancelled', async () => {
    const { runner, store, shop, conv } = withProcessing();
    const paused = await runner.handleUserMessage(conv, 'Cancel order #10, I ordered it by mistake');

    expect(paused.status).toBe('awaiting_approval');
    expect(toolSteps(store)).toEqual(['assistant:get_order', 'tool:get_order', 'assistant:cancel_order']);
    const [action] = [...store.actions.values()];
    expect(action).toMatchObject({
      toolName: 'cancel_order', status: 'pending_approval',
      toolArgs: { orderId: 10, reason: 'Cancel order #10, I ordered it by mistake' },
    });
    expect(action.reasoning).toContain('reviewed');
    expect((await shop.getOrder(10))?.status).toBe('processing');

    const { run } = await runner.decide(action.id, 'approve');
    expect(run.status).toBe('completed');
    expect((await shop.getOrder(10))?.status).toBe('cancelled');
    expect(lastText(store)).toBe('Order #10 has been cancelled.');
  });

  it('truncates a long cancellation reason to 300 characters', async () => {
    const { runner, store, conv } = withProcessing();
    await runner.handleUserMessage(conv, `cancel order #10 ${'because '.repeat(100)}`);
    const [action] = [...store.actions.values()];
    expect((action.toolArgs as any).reason).toHaveLength(300);
  });

  it('tells the customer a reviewer declined, with the reviewer note when present', async () => {
    const { runner, store, shop, conv } = withProcessing();
    await runner.handleUserMessage(conv, 'Cancel order #10 please');
    const [action] = [...store.actions.values()];
    const { run } = await runner.decide(action.id, 'reject', 'Already packed');

    expect(run.status).toBe('completed');
    expect((await shop.getOrder(10))?.status).toBe('processing');
    expect(lastText(store)).toContain('A reviewer declined the cancellation of order #10.');
    expect(lastText(store)).toContain('Already packed');
  });

  it('declines without a note too', async () => {
    const { runner, store, conv } = withProcessing();
    await runner.handleUserMessage(conv, 'Cancel order #10 please');
    const [action] = [...store.actions.values()];
    await runner.decide(action.id, 'reject');
    expect(lastText(store)).toContain('A reviewer declined the cancellation of order #10.');
  });

  it('asks which order when none is named', async () => {
    const { runner, store, conv } = withProcessing();
    const run = await runner.handleUserMessage(conv, 'Cancel my order');

    expect(run.status).toBe('completed');
    expect(toolSteps(store)).toEqual(['assistant:list_orders', 'tool:list_orders']);
    expect(lastText(store)).toContain('Which order would you like to cancel?');
    expect(lastText(store)).toContain('#10');
    expect(store.actions.size).toBe(0);
  });

  it('never parks a delivered order: the guardrail answers first', async () => {
    const { runner, store, conv } = setup();
    const run = await runner.handleUserMessage(conv, 'Cancel order #1');

    expect(run.status).toBe('completed');
    expect(store.actions.size).toBe(0);
    expect(lastText(store)).toMatch(/^I wasn't able to do that: /);
  });

  it('gives the refund path priority when a message mentions both refund and cancel', async () => {
    const { runner, store, conv } = withProcessing();
    await runner.handleUserMessage(conv, 'Cancel order #1 and refund me');
    expect(toolSteps(store)).toEqual(['assistant:get_order', 'tool:get_order', 'assistant:issue_refund']);
  });

  it('tracks a shipped order and summarises carrier, tracking number and status', async () => {
    const { runner, store, conv } = setup();
    const run = await runner.handleUserMessage(conv, 'Where is my order #1?');

    expect(run.status).toBe('completed');
    expect(toolSteps(store)).toEqual(['assistant:track_shipment', 'tool:track_shipment']);
    expect(lastText(store)).toBe(
      'Order #1 shipped with FedEx (tracking FX900000001): delivered, ETA 2026-01-04. Latest: Delivered (Front door).',
    );
  });

  it('answers "track order #N" the same way', async () => {
    const { runner, store, conv } = setup();
    await runner.handleUserMessage(conv, 'track order #1');
    expect(toolSteps(store)).toEqual(['assistant:track_shipment', 'tool:track_shipment']);
    expect(lastText(store)).toContain('FedEx');
  });

  it('says a not-yet-shipped order has not shipped, with its status', async () => {
    const { runner, store, conv } = withProcessing();
    await runner.handleUserMessage(conv, 'Where is my order #10?');
    expect(lastText(store)).toBe('Order #10 has not shipped yet (it is processing).');
  });

  it('asks which order when tracking without an id', async () => {
    const { runner, store, conv } = withProcessing();
    await runner.handleUserMessage(conv, 'where is my package');
    expect(toolSteps(store)).toEqual(['assistant:list_orders', 'tool:list_orders']);
    expect(lastText(store)).toContain('Which order would you like to track?');
  });

  it("refuses to track another customer's order", async () => {
    const { runner, store, conv } = setup();
    await runner.handleUserMessage(conv, 'track order #2');
    expect(lastText(store)).toMatch(/^I wasn't able to do that: /);
    expect(lastText(store)).not.toContain('UPS');
  });

  it('leaves the ordinary flows alone', async () => {
    const { runner, store, conv } = setup();
    await runner.handleUserMessage(conv, 'Why was order #3 cancelled?');
    expect(toolSteps(store)).toEqual(['assistant:get_order', 'tool:get_order']);
    expect(lastText(store)).toContain('Order #3 is cancelled');
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

  it('still carries out a reviewer decision when the budget ran out while it waited, then stops', async () => {
    const mock = new MockProvider();
    const metered: ChatProvider = {
      name: 'metered',
      complete: async (messages) => ({ ...(await mock.complete(messages)), usage: { inputTokens: 60, outputTokens: 40 } }),
    };
    const { runner, store, shop, conv } = setup(metered, 8, 150);
    expect((await runner.handleUserMessage(conv, 'refund order #1')).status).toBe('awaiting_approval'); // 200 tokens spent
    const [action] = [...store.actions.values()];

    const { run } = await runner.decide(action.id, 'approve');

    expect(shop.refunds).toHaveLength(1); // the approved refund is not lost to the cap
    expect(store.actions.get(action.id)!.result).toMatchObject({ status: 'refunded' });
    expect(run.status).toBe('budget_exceeded');
    expect(store.steps.at(-1)?.content).toContain('usage limit');
  });

  it('counts the usage of an empty reply that was refused, so it cannot be used to dodge the budget', async () => {
    const empty: ChatProvider = { name: 'empty', complete: async () => ({ text: '', toolCalls: [], usage: { inputTokens: 100, outputTokens: 0 } }) };
    const { runner, store, conv } = setup(empty, 8, 150);
    await runner.handleUserMessage(conv, 'a').catch(() => undefined);
    await runner.handleUserMessage(conv, 'b').catch(() => undefined);
    expect(await store.conversationUsage(conv.id)).toEqual({ inputTokens: 200, outputTokens: 0 });
    expect((await runner.handleUserMessage(conv, 'c')).status).toBe('budget_exceeded');
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

describe('failures around a run', () => {
  it('does not leave the conversation blocked when the first user message cannot be saved', async () => {
    const { runner, store, conv } = setup();
    const addStep = store.addStep.bind(store);
    store.addStep = async () => { throw new Error('db down'); };
    await expect(runner.handleUserMessage(conv, 'hi')).rejects.toThrow('db down');
    expect([...store.runs.values()][0]).toMatchObject({ status: 'failed', error: 'db down' });

    store.addStep = addStep; // the database recovers: the customer can simply try again
    expect((await runner.handleUserMessage(conv, 'hi again')).status).toBe('completed');
  });

  it('treats an empty model reply as a failed call instead of storing a blank message', async () => {
    const { runner, store, conv } = setup(scripted([{ text: '  ', toolCalls: [] }]));
    await expect(runner.handleUserMessage(conv, 'hi')).rejects.toBeInstanceOf(UpstreamLlmError);
    expect([...store.runs.values()][0].status).toBe('failed');
    // the billed call stays visible in the trace, flagged, but is never replayed to the model
    expect(store.steps.filter((s) => s.role === 'assistant')).toEqual([
      expect.objectContaining({ content: '', result: expect.objectContaining({ code: 'EMPTY_RESPONSE' }) }),
    ]);
  });

  describe('when an approval cannot be completed after it was claimed', () => {
    const park = async () => {
      const ctx = setup();
      await ctx.runner.handleUserMessage(ctx.conv, 'refund order #1');
      const [action] = [...ctx.store.actions.values()];
      return { ...ctx, action };
    };

    it('reopens it if saving the result fails, so the reviewer can retry (the refund is idempotent per approval)', async () => {
      const { runner, store, action } = await park();
      const setActionResult = store.setActionResult.bind(store);
      store.setActionResult = async () => { throw new Error('db down'); };
      await expect(runner.decide(action.id, 'approve')).rejects.toThrow('db down');
      expect(store.actions.get(action.id)).toMatchObject({ status: 'pending_approval', result: null });
      expect([...store.runs.values()][0].status).toBe('awaiting_approval');

      store.setActionResult = setActionResult;
      expect((await runner.decide(action.id, 'approve')).run.status).toBe('completed');
    });

    it('fails the run, rather than leaving it parked forever, once the result is saved but the trace cannot be', async () => {
      const { runner, store, action, conv } = await park();
      const addStep = store.addStep.bind(store);
      store.addStep = async (s) => { if (s.role === 'tool' && s.toolName === 'issue_refund') throw new Error('db down'); return addStep(s); };
      await expect(runner.decide(action.id, 'approve')).rejects.toThrow('db down');
      expect(store.actions.get(action.id)?.result).not.toBeNull(); // the decision stands; it is not re-executed
      expect([...store.runs.values()][0].status).toBe('failed');

      store.addStep = addStep;
      expect((await runner.handleUserMessage(conv, 'hello again')).status).toBe('completed'); // not blocked
    });

    it('answers with a tool error instead of crashing when the parked tool no longer exists', async () => {
      const { runner, store, conv } = setup();
      const run = await store.createRun(conv.id);
      await store.updateRun(run.id, { status: 'awaiting_approval' });
      const action = await store.createAction({
        runId: run.id, conversationId: conv.id, toolName: 'retired_tool', toolArgs: {}, toolCallId: 't1', reasoning: '',
      });
      const out = await runner.decide(action.id, 'approve');
      expect(out.action.result).toMatchObject({ code: 'UNKNOWN_TOOL' });
      expect(out.run.status).toBe('completed');
    });
  });
});

describe('tool arguments the database cannot store', () => {
  it('rejects a NUL character in model-supplied text as invalid arguments instead of failing the run', async () => {
    let i = 0;
    const provider: ChatProvider = {
      name: 'scripted',
      complete: async () => [
        { toolCalls: [{ id: 'a', name: 'create_ticket', args: { subject: 'Late parcel', body: 'bad \u0000 byte' } }] },
        { text: 'done', toolCalls: [] },
      ][i++],
    };
    const { runner, store, conv, shop } = setup(provider);
    expect((await runner.handleUserMessage(conv, 'open a ticket')).status).toBe('completed');
    expect(store.steps.find((x) => x.role === 'tool')?.result).toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(shop.tickets).toHaveLength(0);
  });
});

describe('approval policy', () => {
  const build = (refundAutoApproveUnder: number) => {
    const shop = new MemoryShop();
    const store = new MemoryStore();
    const runner = new AgentRunner({ provider: new MockProvider(), shop, store, approvalPolicy: { refundAutoApproveUnder } });
    return { shop, store, runner, newConversation: (customerId = 1) => store.addConversation(customerId) };
  };

  it('refunds under the threshold without a reviewer, and logs the policy decision', async () => {
    const { runner, store, shop, newConversation } = build(100);
    const run = await runner.handleUserMessage(newConversation(), 'Order #1 arrived damaged, please refund it');

    expect(run.status).toBe('completed');
    expect(store.actions.size).toBe(0); // nothing was parked
    expect(shop.refunds).toEqual([expect.objectContaining({ orderId: 1, amount: 50, actionId: undefined })]);
    expect(store.steps.at(-1)?.content).toContain('approved and issued');
    expect(store.events).toEqual([
      expect.objectContaining({
        kind: 'auto_approved', actorType: 'policy', actionId: null, toolName: 'issue_refund', toolArgs: expect.objectContaining({ orderId: 1, amount: 50 }),
        rule: 'under_threshold', detail: { threshold: 100, priorRefunded: 0, amount: 50 },
      }),
    ]);
  });

  it('parks a refund of exactly the threshold and says why', async () => {
    const { runner, store, shop, newConversation } = build(50);
    const run = await runner.handleUserMessage(newConversation(), 'refund order #1');

    expect(run.status).toBe('awaiting_approval');
    expect(shop.refunds).toHaveLength(0);
    expect(store.events).toEqual([
      expect.objectContaining({ kind: 'requested', actorType: 'policy', rule: 'over_threshold', detail: { threshold: 50, priorRefunded: 0, amount: 50 } }),
    ]);
  });

  it('keeps asking a human for every refund when no threshold is set', async () => {
    const { runner, store, newConversation } = build(0);
    const run = await runner.handleUserMessage(newConversation(), 'refund order #1 $1');
    expect(run.status).toBe('awaiting_approval');
    expect(store.events).toEqual([expect.objectContaining({ kind: 'requested', rule: 'always_review' })]);
  });

  it('counts earlier refunds on the order, so a big refund cannot be split into small ones', async () => {
    const { runner, store, shop, newConversation } = build(40);
    shop.refunds.push({ id: 1, orderId: 1, amount: 30, reason: 'earlier' });

    const big = await runner.handleUserMessage(newConversation(), 'refund order #1 $15'); // 30 + 15 = 45, not under 40
    expect(big.status).toBe('awaiting_approval');

    const small = await runner.handleUserMessage(newConversation(), 'refund order #1 $5'); // 30 + 5 = 35, under 40
    expect(small.status).toBe('completed');
    expect(shop.refunds.map((r) => r.amount)).toEqual([30, 5]);
    expect(store.events.map((e) => e.kind)).toEqual(['requested', 'auto_approved']);
  });

  it('writes the audit event before the refund runs', async () => {
    const { runner, store, shop, newConversation } = build(100);
    const seen: string[][] = [];
    const createRefund = shop.createRefund.bind(shop);
    shop.createRefund = async (input) => {
      seen.push(store.events.map((e) => e.kind));
      return createRefund(input);
    };
    await runner.handleUserMessage(newConversation(), 'refund order #1');
    expect(seen).toEqual([['auto_approved']]);
  });

  it('does not refund, and fails the run, when the audit event cannot be written', async () => {
    const { runner, store, shop, newConversation } = build(100);
    store.addApprovalEvent = async () => { throw new Error('audit down'); };

    await expect(runner.handleUserMessage(newConversation(), 'refund order #1')).rejects.toThrow('audit down');
    expect(shop.refunds).toHaveLength(0);
    expect([...store.runs.values()][0].status).toBe('failed');
  });

  it('still applies the guardrails to a call the policy would auto-approve', async () => {
    const { runner, store, shop, newConversation } = build(1000);

    const over = await runner.handleUserMessage(newConversation(), 'refund order #1 for $500');
    expect(over.status).toBe('completed');
    expect(store.steps.find((s) => s.toolName === 'issue_refund' && s.role === 'tool')?.result).toMatchObject({ code: 'OVER_REFUND' });

    const crossConv = newConversation();
    const cross = await runner.handleUserMessage(crossConv, 'refund order #2'); // belongs to customer 2
    expect(cross.status).toBe('completed');
    expect(store.steps.find((s) => s.role === 'tool' && s.toolName === 'get_order' && s.conversationId === crossConv.id)?.result)
      .toMatchObject({ code: 'CROSS_CUSTOMER' });

    expect(shop.refunds).toHaveLength(0);
    expect(store.events).toEqual([]); // nothing was decided, so nothing is logged
  });
});

describe('approval policy with scripted model calls', () => {
  const build = (provider: ChatProvider, refundAutoApproveUnder: number) => {
    const shop = new MemoryShop();
    const store = new MemoryStore();
    const runner = new AgentRunner({ provider, shop, store, approvalPolicy: { refundAutoApproveUnder } });
    return { shop, store, runner, conv: store.addConversation(1) };
  };

  it("refuses issue_refund on another customer's order even with auto-approval on: no event, no refund", async () => {
    const { runner, store, shop, conv } = build(
      scripted([
        { toolCalls: [{ id: 'r1', name: 'issue_refund', args: { orderId: 2, amount: 5, reason: 'not mine' } }] },
        { text: 'done', toolCalls: [] },
      ]),
      100,
    );
    const run = await runner.handleUserMessage(conv, 'refund order #2');

    expect(run.status).toBe('completed');
    expect(store.steps.find((s) => s.role === 'tool' && s.toolName === 'issue_refund')?.result).toMatchObject({ code: 'CROSS_CUSTOMER' });
    expect(store.events).toEqual([]);
    expect(store.actions.size).toBe(0);
    expect(shop.refunds).toHaveLength(0);
  });

  it('counts refunds made earlier in the same turn: two $10 refunds auto-approve under $25, the third is parked', async () => {
    const refund = (id: string) => ({ id, name: 'issue_refund', args: { orderId: 1, amount: 10, reason: 'damaged item' } });
    const { runner, store, shop, conv } = build(
      scripted([{ toolCalls: [refund('r1'), refund('r2'), refund('r3')] }, { text: 'ok', toolCalls: [] }]),
      25,
    );
    const run = await runner.handleUserMessage(conv, 'refund order #1 three times');

    expect(run.status).toBe('awaiting_approval');
    expect(shop.refunds.map((r) => r.amount)).toEqual([10, 10]); // $20 refunded, the third did not run
    expect([...store.actions.values()]).toEqual([
      expect.objectContaining({ toolCallId: 'r3', status: 'pending_approval', toolArgs: expect.objectContaining({ amount: 10 }) }),
    ]);
    expect(store.events.map((e) => [e.kind, e.rule, e.detail])).toEqual([
      ['auto_approved', 'under_threshold', { threshold: 25, priorRefunded: 0, amount: 10 }],
      ['auto_approved', 'under_threshold', { threshold: 25, priorRefunded: 10, amount: 10 }],
      ['requested', 'over_threshold', { threshold: 25, priorRefunded: 20, amount: 10 }],
    ]);
  });
});

describe('cancel_order approval flow', () => {
  const cancel = (orderId: number) => scripted([
    { toolCalls: [{ id: 'c1', name: 'cancel_order', args: { orderId, reason: 'changed my mind' } }] },
    { text: 'done', toolCalls: [] },
  ]);
  const build = (provider: ChatProvider, approvalPolicy?: { refundAutoApproveUnder: number }) => {
    const shop = new MemoryShop();
    shop.orders.push({ id: 10, customerId: 1, status: 'processing', total: 30, items: [], createdAt: '2026-01-05T00:00:00.000Z' });
    const store = new MemoryStore();
    const runner = new AgentRunner({ provider, shop, store, approvalPolicy });
    return { shop, store, runner, conv: store.addConversation(1) };
  };
  const status = async (shop: MemoryShop) => (await shop.getOrder(10))?.status;

  it('parks the call for a human and leaves the order alone', async () => {
    const { runner, store, shop, conv } = build(cancel(10));
    const run = await runner.handleUserMessage(conv, 'cancel order #10');

    expect(run.status).toBe('awaiting_approval');
    expect([...store.actions.values()]).toEqual([expect.objectContaining({ toolName: 'cancel_order', status: 'pending_approval' })]);
    expect(store.events).toEqual([expect.objectContaining({ kind: 'requested', rule: 'tool_requires_review' })]);
    expect(await status(shop)).toBe('processing');
  });

  it('cancels the order when a reviewer approves, and the run completes', async () => {
    const { runner, store, shop, conv } = build(cancel(10));
    await runner.handleUserMessage(conv, 'cancel order #10');
    const [action] = [...store.actions.values()];
    const { run } = await runner.decide(action.id, 'approve');

    expect(await status(shop)).toBe('cancelled');
    expect(run.status).toBe('completed');
    expect(store.steps.find((s) => s.role === 'tool' && s.toolName === 'cancel_order')?.result).toEqual({ orderId: 10, status: 'cancelled' });
    expect(shop.cancelActions.get(10)).toBe(action.id); // the approval's id reached execute
  });

  it('leaves the order untouched on rejection and tells the model not to retry', async () => {
    const { runner, store, shop, conv } = build(cancel(10));
    await runner.handleUserMessage(conv, 'cancel order #10');
    const [action] = [...store.actions.values()];
    await runner.decide(action.id, 'reject', 'Already packed');

    expect(await status(shop)).toBe('processing');
    expect(store.steps.find((s) => s.role === 'tool' && s.toolName === 'cancel_order')?.result).toMatchObject({
      status: 'rejected', message: expect.stringContaining('Do not retry'),
    });
  });

  it('still parks with a huge refund auto-approve threshold: no auto_approved event', async () => {
    const { runner, store, shop, conv } = build(cancel(10), { refundAutoApproveUnder: 1_000_000 });
    const run = await runner.handleUserMessage(conv, 'cancel order #10');

    expect(run.status).toBe('awaiting_approval');
    expect(store.events.map((e) => e.kind)).toEqual(['requested']);
    expect(await status(shop)).toBe('processing');
  });

  it("refuses another customer's order: a CROSS_CUSTOMER result, no action, no events", async () => {
    const { runner, store, shop, conv } = build(cancel(2));
    const run = await runner.handleUserMessage(conv, 'cancel order #2');

    expect(run.status).toBe('completed');
    expect(store.steps.find((s) => s.role === 'tool' && s.toolName === 'cancel_order')?.result).toMatchObject({ code: 'CROSS_CUSTOMER' });
    expect(store.actions.size).toBe(0);
    expect(store.events).toEqual([]);
    expect(await shop.getOrder(2)).toMatchObject({ status: 'shipped' });
  });
});

describe('audit events for human decisions', () => {
  it('logs requested, then the reviewer decision with its note', async () => {
    const { runner, store, conv } = setup();
    await runner.handleUserMessage(conv, 'refund order #1');
    const [action] = [...store.actions.values()];
    await runner.decide(action.id, 'approve', 'Looks legitimate');

    expect(store.events.map((e) => [e.kind, e.actorType])).toEqual([['requested', 'policy'], ['approved', 'reviewer']]);
    expect(store.events[1]).toMatchObject({ actionId: action.id, note: 'Looks legitimate', toolName: 'issue_refund' });
  });

  it('logs a rejection as rejected, and a system decision as expired', async () => {
    const { runner, store, conv } = setup();
    await runner.handleUserMessage(conv, 'refund order #1');
    const [first] = [...store.actions.values()];
    await runner.decide(first.id, 'reject', 'Outside policy');
    expect(store.events.at(-1)).toMatchObject({ kind: 'rejected', actorType: 'reviewer' });

    const other = store.addConversation(2);
    await runner.handleUserMessage(other, 'refund order #2');
    const second = [...store.actions.values()].find((a) => a.conversationId === other.id)!;
    await runner.decide(second.id, 'reject', 'Expired: no reviewer decision within 1 minute.', 'system');
    expect(store.events.at(-1)).toMatchObject({ kind: 'expired', actorType: 'system', actionId: second.id });
  });

  it('logs no second decision for a double click', async () => {
    const { runner, store, conv } = setup();
    await runner.handleUserMessage(conv, 'refund order #1');
    const [action] = [...store.actions.values()];
    await runner.decide(action.id, 'approve');
    await expect(runner.decide(action.id, 'approve')).rejects.toBeInstanceOf(ConflictError);
    expect(store.events.filter((e) => e.kind === 'approved')).toHaveLength(1);
  });
});
