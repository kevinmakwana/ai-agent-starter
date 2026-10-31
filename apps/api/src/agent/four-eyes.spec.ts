import { MemoryShop, MemoryStore } from '../../test/fakes';
import { MockProvider } from '../providers/mock.provider';
import { ConflictError } from './errors';
import { AgentRunner } from './runner';

const alice = { id: 'rev-alice', name: 'Alice' };
const bob = { id: 'rev-bob', name: 'Bob' };
const carol = { id: 'rev-carol', name: 'Carol' };

function build(fourEyes = { refundOver: 10, cancellations: false }, refundAutoApproveUnder = 0) {
  const shop = new MemoryShop();
  const store = new MemoryStore();
  for (const r of [alice, bob, carol]) store.activeReviewers.add(r.id);
  const runner = new AgentRunner({ provider: new MockProvider(), shop, store, approvalPolicy: { refundAutoApproveUnder, fourEyes } });
  const park = async (message = 'Order #1 arrived damaged, please refund it') => {
    const conv = store.addConversation(1);
    const run = await runner.handleUserMessage(conv, message);
    const action = [...store.actions.values()].find((a) => a.runId === run.id)!;
    return { conv, run, action };
  };
  return { shop, store, runner, park };
}

const kinds = (store: MemoryStore) => store.events.map((e) => e.kind);

describe('four-eyes in the runner', () => {
  it('parks a refund over the threshold needing two approvals, and records that', async () => {
    const { store, park } = build();
    const { run, action } = await park();
    expect(run.status).toBe('awaiting_approval');
    expect(action.approvalsRequired).toBe(2);
    expect(store.events[0]).toMatchObject({ kind: 'requested', detail: expect.objectContaining({ approvalsRequired: 2 }) });
  });

  it('a first approval keeps the action pending, the run waiting and executes nothing', async () => {
    const { runner, store, shop, park } = build();
    const { action, run } = await park();
    const res = await runner.decide(action.id, 'approve', 'looks fine', 'reviewer', alice);
    expect(res.action.status).toBe('pending_approval');
    expect(res.run.status).toBe('awaiting_approval');
    expect((await store.getRun(run.id))?.status).toBe('awaiting_approval');
    expect(shop.refunds).toHaveLength(0);
    expect(store.actions.get(action.id)?.result).toBeNull();
    expect(kinds(store)).toEqual(['requested', 'first_approval']);
    expect(store.events[1]).toMatchObject({ actorType: 'reviewer', actorId: alice.id, note: 'looks fine', detail: { given: 1, required: 2 } });
  });

  it('refuses the same reviewer a second time, with a stable code', async () => {
    const { runner, store, shop, park } = build();
    const { action } = await park();
    await runner.decide(action.id, 'approve', undefined, 'reviewer', alice);
    const err = await runner.decide(action.id, 'approve', undefined, 'reviewer', alice).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('ALREADY_APPROVED_BY_YOU');
    expect(shop.refunds).toHaveLength(0);
    expect(kinds(store)).toEqual(['requested', 'first_approval']);
  });

  it('executes exactly once when a second, different reviewer approves, and names them', async () => {
    const { runner, store, shop, park } = build();
    const { action, run } = await park();
    await runner.decide(action.id, 'approve', undefined, 'reviewer', alice);
    const done = await runner.decide(action.id, 'approve', 'second look ok', 'reviewer', bob);
    expect(done.action.status).toBe('approved');
    expect(done.run.status).toBe('completed');
    expect(shop.refunds).toEqual([expect.objectContaining({ orderId: 1, actionId: action.id })]);
    expect(shop.refunds).toHaveLength(1);
    expect((await store.getRun(run.id))?.status).toBe('completed');
    expect(store.events.at(-1)).toMatchObject({ kind: 'approved', actorId: bob.id, note: 'second look ok' });
    // a third approval is now too late
    await expect(runner.decide(action.id, 'approve', undefined, 'reviewer', carol)).rejects.toThrow('already been decided');
    expect(shop.refunds).toHaveLength(1);
  });

  it('one reject after the first approval rejects the action and tells the agent', async () => {
    const { runner, store, shop, park } = build();
    const { action } = await park();
    await runner.decide(action.id, 'approve', undefined, 'reviewer', alice);
    const res = await runner.decide(action.id, 'reject', 'not convinced', 'reviewer', bob);
    expect(res.action.status).toBe('rejected');
    expect(res.run.status).toBe('completed');
    expect(shop.refunds).toHaveLength(0);
    expect(store.events.at(-1)).toMatchObject({ kind: 'rejected', actorType: 'reviewer', actorId: bob.id });
  });

  it('does not count a first approver who was deactivated in between', async () => {
    const { runner, store, shop, park } = build();
    const { action } = await park();
    await runner.decide(action.id, 'approve', undefined, 'reviewer', alice);
    store.activeReviewers.delete(alice.id);
    const second = await runner.decide(action.id, 'approve', undefined, 'reviewer', bob);
    expect(second.action.status).toBe('pending_approval'); // Bob is again the first
    expect(shop.refunds).toHaveLength(0);
    const third = await runner.decide(action.id, 'approve', undefined, 'reviewer', carol);
    expect(third.action.status).toBe('approved');
    expect(shop.refunds).toHaveLength(1);
    expect(kinds(store)).toEqual(['requested', 'first_approval', 'first_approval', 'approved']);
  });

  it('refuses an approval from a key or demo caller (no identity), but lets them reject', async () => {
    const { runner, store, shop, park } = build();
    const first = await park();
    const err = await runner.decide(first.action.id, 'approve').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('FOUR_EYES_NEEDS_ACCOUNTS');
    expect(store.actions.get(first.action.id)?.status).toBe('pending_approval');
    const second = await park();
    const rejected = await runner.decide(second.action.id, 'reject', 'no', 'reviewer', null);
    expect(rejected.action.status).toBe('rejected');
    expect(shop.refunds).toHaveLength(0);
    expect(store.events.at(-1)).toMatchObject({ kind: 'rejected', actorId: null });
  });

  it('expiry rejects a half-approved action as the system', async () => {
    const { runner, store, shop, park } = build();
    const { action } = await park();
    await runner.decide(action.id, 'approve', undefined, 'reviewer', alice);
    const res = await runner.decide(action.id, 'reject', 'timed out', 'system');
    expect(res.action.status).toBe('rejected');
    expect(shop.refunds).toHaveLength(0);
    expect(store.events.at(-1)).toMatchObject({ kind: 'expired', actorType: 'system', actorId: null });
  });

  it('lets an approver retry after the execution failed and the action was reopened, without a third reviewer', async () => {
    const { runner, store, shop, park } = build();
    const { action } = await park();
    await runner.decide(action.id, 'approve', undefined, 'reviewer', alice);
    jest.spyOn(shop, 'createRefund').mockRejectedValueOnce(new Error('db down'));
    await expect(runner.decide(action.id, 'approve', undefined, 'reviewer', bob)).rejects.toThrow('db down');
    expect(store.actions.get(action.id)?.status).toBe('pending_approval'); // reopened
    // both required approvals are already on record; Alice pressing approve again is a retry, not a second vote
    const retried = await runner.decide(action.id, 'approve', undefined, 'reviewer', alice);
    expect(retried.action.status).toBe('approved');
    expect(shop.refunds).toHaveLength(1);
  });

  it('leaves a refund at or under the threshold needing one approval', async () => {
    const small = build({ refundOver: 100, cancellations: false });
    const { action } = await small.park(); // the mock asks for $50, not over $100
    expect(action.approvalsRequired).toBe(1);
  });

  it('leaves one-approval actions exactly as before: one reviewer approves, executes, and is named', async () => {
    const { runner, store, shop, park } = build({ refundOver: 100, cancellations: false });
    const { action } = await park();
    const res = await runner.decide(action.id, 'approve', undefined, 'reviewer', alice);
    expect(res.action.status).toBe('approved');
    expect(shop.refunds).toHaveLength(1);
    expect(kinds(store)).toEqual(['requested', 'approved']);
    expect(store.events.at(-1)).toMatchObject({ actorId: alice.id });
  });

  it('lets a key or demo caller approve a one-approval action, with no name in the log', async () => {
    const { runner, store, shop, park } = build({ refundOver: 100, cancellations: false });
    const { action } = await park();
    expect((await runner.decide(action.id, 'approve')).action.status).toBe('approved');
    expect(shop.refunds).toHaveLength(1);
    expect(store.events.at(-1)).toMatchObject({ kind: 'approved', actorType: 'reviewer', actorId: null });
  });
});
