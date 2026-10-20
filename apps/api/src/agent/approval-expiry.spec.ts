import { MemoryShop, MemoryStore } from '../../test/fakes';
import { MockProvider } from '../providers/mock.provider';
import { ApprovalExpiry } from './approval-expiry';
import { ConflictError } from './errors';
import { AgentRunner } from './runner';
import type { ChatProvider } from './types';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function setup(provider: ChatProvider = new MockProvider(), ttlMs = 24 * HOUR) {
  const shop = new MemoryShop();
  const store = new MemoryStore();
  const runner = new AgentRunner({ provider, shop, store });
  const errors: unknown[] = [];
  const expiry = new ApprovalExpiry({ store, runner, ttlMs, now: () => NOW, onError: (_id, e) => errors.push(e) });
  const park = async (customerId: number, message: string, ageMs: number) => {
    const conv = store.addConversation(customerId);
    await runner.handleUserMessage(conv, message);
    const action = [...store.actions.values()].find((a) => a.conversationId === conv.id)!;
    action.createdAt = ago(ageMs);
    return { conv, action };
  };
  return { shop, store, runner, expiry, park, errors };
}

describe('ApprovalExpiry', () => {
  it('rejects approvals older than the TTL with a note, tells the customer, and leaves fresh ones pending', async () => {
    const { expiry, park, store, shop } = setup();
    const stale = await park(1, 'refund order #1', 25 * HOUR);
    const fresh = await park(2, 'refund order #2', 23 * HOUR);

    expect(await expiry.sweep()).toEqual({ expired: 1, failed: 0 });

    expect(store.actions.get(stale.action.id)).toMatchObject({ status: 'rejected', decisionNote: expect.stringContaining('Expired') });
    expect(store.actions.get(fresh.action.id)!.status).toBe('pending_approval');
    expect(shop.refunds).toHaveLength(0);
    const lastStale = store.steps.filter((s) => s.conversationId === stale.conv.id).at(-1);
    expect(lastStale?.content).toContain('declined'); // the agent resumed and told the customer
    expect([...store.runs.values()].find((r) => r.conversationId === stale.conv.id)!.status).toBe('completed');
  });

  it('is idempotent: a second sweep finds nothing', async () => {
    const { expiry, park } = setup();
    await park(1, 'refund order #1', 48 * HOUR);
    expect((await expiry.sweep()).expired).toBe(1);
    expect(await expiry.sweep()).toEqual({ expired: 0, failed: 0 });
  });

  it('keeps going and reports when one approval cannot be resumed', async () => {
    const mock = new MockProvider();
    let failAva = false;
    const flaky: ChatProvider = {
      name: 'flaky',
      complete: async (messages) => {
        if (failAva && messages[0].content.includes('Ava Brooks')) throw new Error('llm down');
        return mock.complete(messages);
      },
    };
    const { expiry, park, store, errors } = setup(flaky);
    const ava = await park(1, 'refund order #1', 30 * HOUR);
    const ben = await park(2, 'refund order #2', 30 * HOUR);
    failAva = true;

    expect(await expiry.sweep()).toEqual({ expired: 1, failed: 1 });
    expect(errors).toHaveLength(1);
    expect(store.actions.get(ben.action.id)!.status).toBe('rejected'); // the healthy one was not blocked
    expect(store.actions.get(ava.action.id)!.status).toBe('rejected'); // decided; its run is marked failed, not wedged
    expect([...store.runs.values()].find((r) => r.conversationId === ava.conv.id)!.status).toBe('failed');
  });

  it('does nothing when the TTL is 0 (never expire)', async () => {
    const { expiry, park, store } = setup(new MockProvider(), 0);
    const { action } = await park(1, 'refund order #1', 1000 * HOUR);
    expect(await expiry.sweep()).toEqual({ expired: 0, failed: 0 });
    expect(store.actions.get(action.id)!.status).toBe('pending_approval');
  });

  it.each([
    [5, 'Expired: no reviewer decision within 5 minutes.'],
    [1, 'Expired: no reviewer decision within 1 minute.'],
    [90, 'Expired: no reviewer decision within 90 minutes.'],
    [120, 'Expired: no reviewer decision within 2 hours.'],
    [1440, 'Expired: no reviewer decision within 24 hours.'],
  ])('words a %i-minute TTL in the rejection note readably', async (minutes, note) => {
    const { expiry, park, store } = setup(new MockProvider(), minutes * 60_000);
    const { action } = await park(1, 'refund order #1', (minutes + 1) * 60_000);
    await expiry.sweep();
    expect(store.actions.get(action.id)!.decisionNote).toBe(note);
  });
});

describe('ApprovalExpiry.recoverStranded', () => {
  const MIN = 60_000;
  /** A reviewer's decision was claimed, then the process died before anything else happened. */
  async function crashAfterClaim(ctx: ReturnType<typeof setup>, decision: 'approved' | 'rejected', claimedAgoMs: number) {
    const parked = await ctx.park(1, 'refund order #1', HOUR);
    await ctx.store.decideAction(parked.action.id, decision, 'ok');
    ctx.store.actions.get(parked.action.id)!.decidedAt = ago(claimedAgoMs);
    return parked;
  }

  it('finishes an approved decision exactly once and resumes the run', async () => {
    const ctx = setup();
    const { action, conv } = await crashAfterClaim(ctx, 'approved', 10 * MIN);

    expect(await ctx.expiry.recoverStranded()).toEqual({ recovered: 1, failed: 0 });

    expect(ctx.shop.refunds).toHaveLength(1);
    expect(ctx.store.actions.get(action.id)!.result).toMatchObject({ status: 'refunded' });
    expect([...ctx.store.runs.values()].find((r) => r.conversationId === conv.id)!.status).toBe('completed');
    expect(await ctx.expiry.recoverStranded()).toEqual({ recovered: 0, failed: 0 }); // nothing left to do
  });

  it('does not pay twice when the refund had already committed before the crash', async () => {
    const ctx = setup();
    const { action } = await crashAfterClaim(ctx, 'approved', 10 * MIN);
    await ctx.shop.createRefund({ customerId: 1, orderId: 1, amount: 50, reason: 'damaged', actionId: action.id }); // committed, then died

    await ctx.expiry.recoverStranded();

    expect(ctx.shop.refunds).toHaveLength(1);
    expect(ctx.store.actions.get(action.id)!.result).toMatchObject({ status: 'refunded' });
  });

  it('finishes a rejected decision too, telling the customer', async () => {
    const ctx = setup();
    const { action, conv } = await crashAfterClaim(ctx, 'rejected', 10 * MIN);
    await ctx.expiry.recoverStranded();
    expect(ctx.shop.refunds).toHaveLength(0);
    expect(ctx.store.actions.get(action.id)!.result).toMatchObject({ status: 'rejected' });
    expect(ctx.store.steps.filter((s) => s.conversationId === conv.id).at(-1)?.content).toContain('declined');
  });

  it('leaves a claim alone while it may still be in progress', async () => {
    const ctx = setup();
    const { action } = await crashAfterClaim(ctx, 'approved', 1 * MIN);
    expect(await ctx.expiry.recoverStranded()).toEqual({ recovered: 0, failed: 0 });
    expect(ctx.store.actions.get(action.id)!.result).toBeNull();
  });

  it('leaves pending approvals and completed decisions alone', async () => {
    const ctx = setup();
    const pending = await ctx.park(2, 'refund order #2', 5 * HOUR);
    const done = await ctx.park(1, 'refund order #1', HOUR);
    await ctx.runner.decide(done.action.id, 'approve');
    ctx.store.actions.get(done.action.id)!.decidedAt = ago(HOUR);

    expect(await ctx.expiry.recoverStranded()).toEqual({ recovered: 0, failed: 0 });
    expect(ctx.store.actions.get(pending.action.id)!.status).toBe('pending_approval');
    expect(ctx.shop.refunds).toHaveLength(1);
  });

  it('never touches a decision whose run has already moved on', async () => {
    const ctx = setup();
    const { action, conv } = await crashAfterClaim(ctx, 'approved', 10 * MIN);
    const run = [...ctx.store.runs.values()].find((r) => r.conversationId === conv.id)!;
    await ctx.store.updateRun(run.id, { status: 'failed' });

    expect(await ctx.expiry.recoverStranded()).toEqual({ recovered: 0, failed: 0 });
    await expect(ctx.runner.recover(action.id)).rejects.toBeInstanceOf(ConflictError); // and directly
    expect(ctx.shop.refunds).toHaveLength(0);
  });

  it('refuses to recover an approval that is pending or already has a result', async () => {
    const ctx = setup();
    const pending = await ctx.park(2, 'refund order #2', HOUR);
    await expect(ctx.runner.recover(pending.action.id)).rejects.toBeInstanceOf(ConflictError);
    const done = await ctx.park(1, 'refund order #1', HOUR);
    await ctx.runner.decide(done.action.id, 'approve');
    await expect(ctx.runner.recover(done.action.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(ctx.runner.recover('nope')).rejects.toThrow('not found');
  });

  it('reports a failure and keeps going', async () => {
    const ctx = setup();
    await crashAfterClaim(ctx, 'approved', 10 * MIN);
    ctx.shop.createRefund = async () => { throw new Error('db down'); };
    expect(await ctx.expiry.recoverStranded()).toEqual({ recovered: 0, failed: 1 });
    expect(ctx.errors).toHaveLength(1);
  });
});
