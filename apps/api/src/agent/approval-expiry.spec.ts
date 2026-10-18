import { MemoryShop, MemoryStore } from '../../test/fakes';
import { MockProvider } from '../providers/mock.provider';
import { ApprovalExpiry } from './approval-expiry';
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
});
