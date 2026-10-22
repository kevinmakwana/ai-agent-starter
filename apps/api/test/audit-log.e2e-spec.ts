import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PgAgentStore } from '../src/db/pg-agent.store';
import { seedDatabase } from '../src/db/seed-data';
import { configureApp } from '../src/http/setup';
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

maybe('approval audit log over HTTP (real Postgres)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const reviewer = { Authorization: 'Bearer s3cret' };

  const boot = async (env: Record<string, string> = {}) => {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    process.env.REVIEWER_API_KEY = 's3cret';
    Object.assign(process.env, env);
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    configureApp(app);
    await app.init();
    await seedDatabase(app.get(PG_POOL));
  };
  const start = async (customerId: number) => {
    const res = await http().post('/conversations').send({ customerId }).expect(201);
    return { id: res.body.id as string, token: { 'x-conversation-token': res.body.accessToken as string } };
  };
  const say = (c: { id: string; token: Record<string, string> }, content: string) =>
    http().post(`/conversations/${c.id}/messages`).set(c.token).send({ content }).expect(201);

  afterEach(async () => {
    await app?.close();
    delete process.env.REVIEWER_API_KEY;
    delete process.env.REFUND_AUTO_APPROVE_UNDER;
  });

  describe('with the default policy (every refund reviewed)', () => {
    beforeEach(() => boot());

    it('logs requested then approved, newest first, and explains the wait on the approval', async () => {
      const c = await start(1);
      await say(c, 'Order #1 arrived damaged, please refund it');

      const [pending] = (await http().get('/approvals?status=pending').set(reviewer).expect(200)).body;
      expect(pending).toMatchObject({ policyRule: 'always_review' });
      await http().post(`/approvals/${pending.id}`).set(reviewer).send({ decision: 'approve', note: 'ok' }).expect(201);

      const events = (await http().get('/approvals/events').set(reviewer).expect(200)).body;
      expect(events.map((e: any) => [e.kind, e.actorType])).toEqual([['approved', 'reviewer'], ['requested', 'policy']]);
      expect(events[0]).toMatchObject({ actionId: pending.id, note: 'ok', actorId: null, toolName: 'issue_refund' });
      expect(events[0].toolArgs).toMatchObject({ orderId: 1, amount: 18.75 });
    });

    it('filters by conversation and pages with limit and before', async () => {
      const a = await start(1);
      const b = await start(2);
      await say(a, 'refund order #1');
      await say(b, 'refund order #12');

      const mine = (await http().get(`/approvals/events?conversationId=${a.id}`).set(reviewer).expect(200)).body;
      expect(mine).toHaveLength(1);
      expect(mine[0].conversationId).toBe(a.id);

      const first = (await http().get('/approvals/events?limit=1').set(reviewer).expect(200)).body;
      expect(first).toHaveLength(1);
      const rest = (await http().get(`/approvals/events?limit=10&before=${first[0].id}`).set(reviewer).expect(200)).body;
      expect(rest).toHaveLength(1);
      expect(rest[0].id).toBeLessThan(first[0].id);
    });

    it('rejects bad query input with 400, not a database error', async () => {
      for (const q of ['limit=0', 'limit=201', 'limit=many', 'before=0', 'before=abc', 'conversationId=nope', 'extra=1']) {
        await http().get(`/approvals/events?${q}`).set(reviewer).expect(400);
      }
    });

    it('is for reviewers only: a conversation token is not enough', async () => {
      const c = await start(1);
      await http().get('/approvals/events').expect(401);
      await http().get('/approvals/events').set(c.token).expect(401);
      await http().get('/approvals/events').set(reviewer).expect(200);
    });

  });

  describe('with REFUND_AUTO_APPROVE_UNDER=25', () => {
    beforeEach(() => boot({ REFUND_AUTO_APPROVE_UNDER: '25' }));

    it('refunds order #1 (18.75) at once, logs auto_approved, and leaves no approval or action_id', async () => {
      const c = await start(1);
      const sent = await say(c, 'Order #1 arrived damaged, please refund it');
      expect(sent.body.run.status).toBe('completed');

      expect((await http().get('/approvals').set(reviewer).expect(200)).body).toEqual([]);
      const pool = app.get<Pool>(PG_POOL);
      const { rows } = await pool.query('SELECT amount::float AS amount, action_id FROM refunds WHERE order_id = 1');
      expect(rows).toEqual([{ amount: 18.75, action_id: null }]);

      const events = (await http().get('/approvals/events').set(reviewer).expect(200)).body;
      expect(events).toEqual([
        expect.objectContaining({
          kind: 'auto_approved', actorType: 'policy', actionId: null, rule: 'under_threshold',
          detail: { threshold: 25, priorRefunded: 0, amount: 18.75 },
        }),
      ]);
    });

    it('hides the policy rule and threshold from the customer view of a conversation, not from reviewers', async () => {
      const c = await start(2);
      const sent = await say(c, 'refund order #12');
      expect(sent.body.run.status).toBe('awaiting_approval');

      const asCustomer = (await http().get(`/conversations/${c.id}`).set(c.token).expect(200)).body;
      expect(asCustomer.approvals).toHaveLength(1);
      expect(asCustomer.approvals[0]).not.toHaveProperty('policyRule');
      expect(asCustomer.approvals[0]).not.toHaveProperty('policyDetail');
      expect(JSON.stringify(asCustomer)).not.toContain('over_threshold');
      expect(JSON.stringify(asCustomer)).not.toContain('"threshold"');
      expect(JSON.stringify(sent.body)).not.toContain('"threshold"');

      const asReviewer = (await http().get(`/conversations/${c.id}`).set(reviewer).expect(200)).body;
      expect(asReviewer.approvals[0]).toMatchObject({ policyRule: 'over_threshold', policyDetail: { threshold: 25 } });
    });

    it('still parks a refund that would push the order to the threshold', async () => {
      const c = await start(2); // order 12: total 66.99, 10.00 already refunded, 56.99 refundable
      const sent = await say(c, 'refund order #12');
      expect(sent.body.run.status).toBe('awaiting_approval');
      const [approval] = (await http().get('/approvals?status=pending').set(reviewer).expect(200)).body;
      expect(approval).toMatchObject({ policyRule: 'over_threshold', policyDetail: { threshold: 25, priorRefunded: 10, amount: 56.99 } });
    });
  });
});
