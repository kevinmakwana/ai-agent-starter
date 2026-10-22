import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { PgAgentStore } from '../src/db/pg-agent.store';
import { seedDatabase } from '../src/db/seed-data';
import { PG_POOL } from '../src/tokens';

// Runs against a real Postgres; skipped unless E2E_DATABASE_URL is set (CI sets it).
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

maybe('approval audit log in the store (real Postgres)', () => {
  let app: INestApplication;
  let store: PgAgentStore;
  let pool: Pool;

  beforeEach(async () => {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init();
    store = app.get(PgAgentStore);
    pool = app.get(PG_POOL);
    await seedDatabase(pool);
  });
  afterEach(() => app?.close());

  const toolArgs = { orderId: 1, amount: 18.75, reason: 'damaged' };
  const park = async () => {
    const conv = await store.createConversation(1, 't');
    const run = await store.createRun(conv.id);
    const action = await store.createAction({
      runId: run.id, conversationId: conv.id, toolName: 'issue_refund', toolArgs, toolCallId: 'call_1', reasoning: 'r',
      policy: { rule: 'over_threshold', detail: { threshold: 10, priorRefunded: 0, amount: 18.75 } },
    });
    return { conv, run, action };
  };

  it('writes a requested event together with the action', async () => {
    const { action, run, conv } = await park();
    const events = await store.listApprovalEvents({ conversationId: conv.id });
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'requested', actionId: action.id, runId: run.id, conversationId: conv.id, actorType: 'policy', actorId: null,
        toolName: 'issue_refund', toolArgs, rule: 'over_threshold', detail: { threshold: 10, priorRefunded: 0, amount: 18.75 }, note: null,
      }),
    ]);
  });

  it('writes a requested event with no rule when the caller gave no policy', async () => {
    const conv = await store.createConversation(1, 't');
    const run = await store.createRun(conv.id);
    await store.createAction({ runId: run.id, conversationId: conv.id, toolName: 'issue_refund', toolArgs, toolCallId: 'c', reasoning: 'r' });
    expect(await store.listApprovalEvents({ conversationId: conv.id })).toEqual([
      expect.objectContaining({ kind: 'requested', rule: null, detail: null }),
    ]);
  });

  it('writes one decision event with the note and defaults the actor to a reviewer', async () => {
    const { action, conv } = await park();
    await store.decideAction(action.id, 'approved', 'looks fine');
    const [decision] = await store.listApprovalEvents({ conversationId: conv.id });
    expect(decision).toMatchObject({ kind: 'approved', actionId: action.id, actorType: 'reviewer', note: 'looks fine', toolArgs });
  });

  it('writes exactly one decision event when two decisions race', async () => {
    const { action, conv } = await park();
    const results = await Promise.all([
      store.decideAction(action.id, 'approved', 'a'),
      store.decideAction(action.id, 'rejected', 'b'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const kinds = (await store.listApprovalEvents({ conversationId: conv.id })).map((e) => e.kind);
    expect(kinds.filter((k) => k !== 'requested')).toHaveLength(1);
  });

  it('records an expiry as a system decision', async () => {
    const { action, conv } = await park();
    await store.decideAction(action.id, 'rejected', 'Expired: no reviewer decision within 1 minute.', { kind: 'expired', actorType: 'system' });
    expect((await store.listApprovalEvents({ conversationId: conv.id }))[0]).toMatchObject({ kind: 'expired', actorType: 'system' });
  });

  it('logs an auto-approval that has no action row', async () => {
    const conv = await store.createConversation(1, 't');
    const run = await store.createRun(conv.id);
    const saved = await store.addApprovalEvent({
      kind: 'auto_approved', runId: run.id, conversationId: conv.id, actorType: 'policy', toolName: 'issue_refund', toolArgs,
      rule: 'under_threshold', detail: { threshold: 25 },
    });
    expect(saved).toMatchObject({ id: expect.any(Number), actionId: null, rule: 'under_threshold', note: null });
  });

  it('lists newest first, filters by conversation, and pages with before', async () => {
    const a = await park();
    const b = await park();
    await store.decideAction(a.action.id, 'approved');
    await store.decideAction(b.action.id, 'rejected');

    const all = await store.listApprovalEvents();
    expect(all.map((e) => e.kind)).toEqual(['rejected', 'approved', 'requested', 'requested']);
    expect(all.map((e) => e.id)).toEqual([...all.map((e) => e.id)].sort((x, y) => y - x));

    expect((await store.listApprovalEvents({ conversationId: a.conv.id })).map((e) => e.kind)).toEqual(['approved', 'requested']);
    expect(await store.listApprovalEvents({ limit: 2 })).toHaveLength(2);
    const older = await store.listApprovalEvents({ before: all[1].id, limit: 10 });
    expect(older.map((e) => e.id)).toEqual(all.slice(2).map((e) => e.id));
  });

  it('exposes why a human was needed on the approval listing', async () => {
    const { action } = await park();
    const [view] = await store.listApprovals({ status: 'pending_approval' });
    expect(view).toMatchObject({ id: action.id, policyRule: 'over_threshold', policyDetail: { threshold: 10, priorRefunded: 0, amount: 18.75 } });
  });

  it('removes events with their conversation and is wiped by a re-seed', async () => {
    const { conv } = await park();
    await pool.query('DELETE FROM conversations WHERE id = $1', [conv.id]);
    expect(await store.listApprovalEvents({ conversationId: conv.id })).toEqual([]);

    await park();
    await seedDatabase(pool);
    expect(await store.listApprovalEvents()).toEqual([]);
  });
});
