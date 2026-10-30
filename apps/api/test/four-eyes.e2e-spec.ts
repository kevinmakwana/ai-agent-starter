import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ApprovalExpiry } from '../src/agent/approval-expiry';
import { hashPassword } from '../src/auth/password';
import type { ReviewerStore } from '../src/auth/reviewer.store';
import { REVIEWER_STORE } from '../src/auth/tokens';
import { createPool } from '../src/db/pool';
import { seedDatabase } from '../src/db/seed-data';
import { configureApp } from '../src/http/setup';
import { PgAgentStore } from '../src/db/pg-agent.store';
import { PG_POOL } from '../src/tokens';

// Runs against a real Postgres; skipped unless E2E_DATABASE_URL is set (CI sets it).
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

const PW = 'correct horse battery';
const CSRF = { 'X-Requested-By': 'reviewer-console' };
const REFUND = 'Order #1 arrived damaged, please refund it'; // the mock asks for $50
const CANCEL = 'Cancel order #11, I ordered it by mistake';
const ENV_KEYS = ['REVIEWER_API_KEY', 'FOUR_EYES_REFUND_OVER', 'FOUR_EYES_CANCELLATIONS', 'REFUND_AUTO_APPROVE_UNDER'];
const UNSEEN = ['approvalsRequired', 'approvalsGiven', 'approvedBy'];

maybe('four-eyes approvals over HTTP (e2e, real Postgres)', () => {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let app: INestApplication;
  let pool: Pool;
  let store: ReviewerStore;
  const http = () => request(app.getHttpServer());

  const boot = async (env: Record<string, string> = { FOUR_EYES_REFUND_OVER: '10' }) => {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    Object.assign(process.env, env);
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    configureApp(app);
    await app.init();
    pool = app.get(PG_POOL);
    store = app.get(REVIEWER_STORE);
    await seedDatabase(pool);
  };

  /** Creates a reviewer and returns their session cookie. */
  const signIn = async (name: string, role: 'admin' | 'reviewer' = 'reviewer') => {
    const r = await store.createReviewer({ email: `${name}@example.com`, name, role, passwordHash: await hashPassword(PW) });
    const res = await http().post('/auth/login').set(CSRF).send({ email: r.email, password: PW }).expect(200);
    return { id: r.id, cookie: (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0] };
  };

  const decide = (cookie: string, id: string, decision: 'approve' | 'reject' = 'approve', note?: string) =>
    http().post(`/approvals/${id}`).set('Cookie', cookie).set(CSRF).send({ decision, note });
  const view = async (cookie: string, status = 'pending') => (await http().get(`/approvals?status=${status}`).set('Cookie', cookie).expect(200)).body;
  const events = async (cookie: string) => (await http().get('/approvals/events').set('Cookie', cookie).expect(200)).body.reverse();
  const refunds = async () => (await pool.query('SELECT count(*)::int AS n FROM refunds WHERE order_id = 1')).rows[0].n as number;

  /** A customer asks for the $50 refund; returns the parked approval. */
  const parkRefund = async (cookie: string, customerId = 1, message = REFUND) => {
    const conv = (await http().post('/conversations').send({ customerId }).expect(201)).body;
    const sent = await http().post(`/conversations/${conv.id}/messages`).set('X-Conversation-Token', conv.accessToken).send({ content: message }).expect(201);
    expect(sent.body.run.status).toBe('awaiting_approval');
    const [approval] = (await view(cookie)).filter((a: { conversationId: string }) => a.conversationId === conv.id);
    return { conv, approval };
  };

  afterEach(async () => {
    await app?.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });
  afterAll(async () => {
    const cleanup = createPool(process.env.E2E_DATABASE_URL!);
    await seedDatabase(cleanup);
    await cleanup.end();
  });

  describe('a refund over the threshold', () => {
    beforeEach(() => boot());

    it('parks needing two approvals; the first approval is recorded and executes nothing', async () => {
      const alice = await signIn('alice');
      const { approval } = await parkRefund(alice.cookie);
      expect(approval).toMatchObject({ approvalsRequired: 2, approvalsGiven: 0, approvedBy: [], status: 'pending_approval', policyRule: 'always_review' });

      const first = await decide(alice.cookie, approval.id, 'approve', 'looks right').expect(201);
      expect(first.body.action.status).toBe('pending_approval');
      expect(first.body.run.status).toBe('awaiting_approval');
      expect(await refunds()).toBe(0);

      const [now] = await view(alice.cookie);
      expect(now).toMatchObject({ status: 'pending_approval', approvalsRequired: 2, approvalsGiven: 1, approvedBy: ['alice'] });
      const log = await events(alice.cookie);
      expect(log.map((e: { kind: string }) => e.kind)).toEqual(['requested', 'first_approval']);
      expect(log[0].detail).toMatchObject({ approvalsRequired: 2 });
      expect(log[1]).toMatchObject({ actorType: 'reviewer', actorId: alice.id, actorName: 'alice', note: 'looks right', detail: { given: 1, required: 2 } });
    });

    it('refuses the same reviewer a second time with ALREADY_APPROVED_BY_YOU', async () => {
      const alice = await signIn('alice');
      const { approval } = await parkRefund(alice.cookie);
      await decide(alice.cookie, approval.id).expect(201);
      const again = await decide(alice.cookie, approval.id).expect(409);
      expect(again.body.code).toBe('ALREADY_APPROVED_BY_YOU');
      expect(await refunds()).toBe(0);
      expect((await view(alice.cookie))[0].approvalsGiven).toBe(1);
    });

    it('a second, different reviewer executes the refund once and the run completes; the log names both', async () => {
      const alice = await signIn('alice');
      const bob = await signIn('bob');
      const { approval, conv } = await parkRefund(alice.cookie);
      await decide(alice.cookie, approval.id).expect(201);
      const done = await decide(bob.cookie, approval.id, 'approve', 'second').expect(201);
      expect(done.body.action.status).toBe('approved');
      expect(done.body.run.status).toBe('completed');
      expect(await refunds()).toBe(1);
      expect((await pool.query('SELECT action_id FROM refunds WHERE order_id = 1')).rows[0].action_id).toBe(approval.id);

      const [decided] = await view(alice.cookie, 'approved');
      expect(decided).toMatchObject({ approvalsGiven: 2, approvedBy: ['alice', 'bob'] });
      const log = await events(alice.cookie);
      expect(log.map((e: { kind: string; actorName: string | null }) => [e.kind, e.actorName])).toEqual([['requested', null], ['first_approval', 'alice'], ['approved', 'bob']]);
      await decide(bob.cookie, approval.id).expect(409); // already decided
      expect(await refunds()).toBe(1);
      expect(conv.id).toBeDefined();
    });

    it('two concurrent second approvals execute exactly once (one 201, one 409)', async () => {
      const [alice, bob, carol] = [await signIn('alice'), await signIn('bob'), await signIn('carol')];
      const { approval } = await parkRefund(alice.cookie);
      await decide(alice.cookie, approval.id).expect(201);
      const [a, b] = await Promise.all([decide(bob.cookie, approval.id), decide(carol.cookie, approval.id)]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await refunds()).toBe(1);
      expect((await pool.query('SELECT count(*)::int AS n FROM action_approvals WHERE action_id = $1', [approval.id])).rows[0].n).toBe(3 - 1);
    });

    it('many reviewers approving at the same instant: exactly one transition reaches the count', async () => {
      const first = await signIn('first');
      const { approval } = await parkRefund(first.cookie);
      const agentStore = app.get(PgAgentStore);
      const others = await Promise.all(Array.from({ length: 9 }, (_, i) => signIn(`r${i}`)));
      await agentStore.approveStep(approval.id, { id: first.id });
      // open connections up front, otherwise handshakes stagger the attempts and hide the race
      await Promise.all(Array.from({ length: 9 }, () => pool.query('SELECT pg_sleep(0.05)')));
      const results = await Promise.all(others.map((r) => agentStore.approveStep(approval.id, { id: r.id })));
      expect(results.filter((r) => r?.final === true)).toHaveLength(1);
      expect(results.filter((r) => r === null)).toHaveLength(8);
      expect((await pool.query('SELECT count(*)::int AS n FROM approval_events WHERE kind = $1 AND action_id = $2', ['approved', approval.id])).rows[0].n).toBe(1);
      expect((await pool.query('SELECT count(*)::int AS n FROM action_approvals WHERE action_id = $1', [approval.id])).rows[0].n).toBe(2);
    });

    it('one reviewer racing two first approvals cannot satisfy four-eyes alone', async () => {
      const alice = await signIn('alice');
      const { approval } = await parkRefund(alice.cookie);
      const results = await Promise.all([decide(alice.cookie, approval.id), decide(alice.cookie, approval.id), decide(alice.cookie, approval.id)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'ALREADY_APPROVED_BY_YOU')).toBe(true);
      expect(await refunds()).toBe(0);
      const [still] = await view(alice.cookie);
      expect(still).toMatchObject({ status: 'pending_approval', approvalsGiven: 1 });
    });

    it('one reject rejects, even after a first approval, and the agent tells the customer', async () => {
      const alice = await signIn('alice');
      const bob = await signIn('bob');
      const { approval, conv } = await parkRefund(alice.cookie);
      await decide(alice.cookie, approval.id).expect(201);
      const rejected = await decide(bob.cookie, approval.id, 'reject', 'no').expect(201);
      expect(rejected.body.action.status).toBe('rejected');
      expect(rejected.body.run.status).toBe('completed');
      expect(await refunds()).toBe(0);
      const log = await events(alice.cookie);
      expect(log.at(-1)).toMatchObject({ kind: 'rejected', actorId: bob.id, actorName: 'bob' });
      const trace = await http().get(`/conversations/${conv.id}`).set('Cookie', alice.cookie).expect(200);
      expect(trace.body.runs.at(-1).status).toBe('completed');
      await decide(alice.cookie, approval.id).expect(409);
    });

    it('does not count a first approver deactivated in between', async () => {
      const admin = await signIn('admin', 'admin');
      const alice = await signIn('alice');
      const bob = await signIn('bob');
      const { approval } = await parkRefund(admin.cookie);
      await decide(alice.cookie, approval.id).expect(201);
      await http().patch(`/reviewers/${alice.id}`).set('Cookie', admin.cookie).set(CSRF).send({ active: false }).expect(200);

      const second = await decide(bob.cookie, approval.id).expect(201);
      expect(second.body.action.status).toBe('pending_approval'); // Bob is the first approver again
      expect(await refunds()).toBe(0);
      const [now] = await view(admin.cookie);
      expect(now).toMatchObject({ approvalsGiven: 1, approvedBy: ['bob'] });
      const done = await decide(admin.cookie, approval.id).expect(201);
      expect(done.body.action.status).toBe('approved');
      expect(await refunds()).toBe(1);
      // audit history keeps the deactivated reviewer's name
      expect((await events(admin.cookie)).map((e: { actorName: string | null }) => e.actorName)).toEqual([null, 'alice', 'bob', 'admin']);
    });

    it('expiry rejects a half-approved action as the system', async () => {
      const alice = await signIn('alice');
      const { approval, conv } = await parkRefund(alice.cookie);
      await decide(alice.cookie, approval.id).expect(201);
      await pool.query("UPDATE actions SET created_at = now() - interval '25 hours' WHERE id = $1", [approval.id]);
      expect(await app.get(ApprovalExpiry).sweep()).toEqual({ expired: 1, failed: 0 });
      expect(await refunds()).toBe(0);
      const log = await events(alice.cookie);
      expect(log.at(-1)).toMatchObject({ kind: 'expired', actorType: 'system', actorId: null, actorName: null });
      expect((await http().get(`/conversations/${conv.id}`).set('Cookie', alice.cookie)).body.runs.at(-1).status).toBe('completed');
    });

    it('never shows a customer the approval count, who approved, or the policy', async () => {
      const alice = await signIn('alice');
      const { approval, conv } = await parkRefund(alice.cookie);
      await decide(alice.cookie, approval.id).expect(201);
      const mine = await http().get(`/conversations/${conv.id}`).set('X-Conversation-Token', conv.accessToken).expect(200);
      expect(mine.body.approvals).toHaveLength(1);
      for (const key of [...UNSEEN, 'policyRule', 'policyDetail']) expect(mine.body.approvals[0]).not.toHaveProperty(key);
      expect(JSON.stringify(mine.body)).not.toMatch(/alice|first_approval|approvalsRequired/);
      const asReviewer = await http().get(`/conversations/${conv.id}`).set('Cookie', alice.cookie).expect(200);
      for (const key of UNSEEN) expect(asReviewer.body.approvals[0]).toHaveProperty(key);
    });

    it('leaves a refund at or under the threshold needing one approval', async () => {
      await app.close();
      await boot({ FOUR_EYES_REFUND_OVER: '50' }); // the mock asks for exactly $50: not "over"
      const alice = await signIn('alice');
      const { approval } = await parkRefund(alice.cookie);
      expect(approval).toMatchObject({ approvalsRequired: 1, approvalsGiven: 0 });
      const done = await decide(alice.cookie, approval.id).expect(201);
      expect(done.body.action.status).toBe('approved');
      expect(await refunds()).toBe(1);
      expect((await events(alice.cookie)).map((e: { kind: string; actorName: string | null }) => [e.kind, e.actorName])).toEqual([['requested', null], ['approved', 'alice']]);
    });
  });

  describe('cancellations', () => {
    it('need two approvals only when FOUR_EYES_CANCELLATIONS is on', async () => {
      await boot({ FOUR_EYES_CANCELLATIONS: 'true' });
      const alice = await signIn('alice');
      const bob = await signIn('bob');
      const { approval } = await parkRefund(alice.cookie, 1, CANCEL);
      expect(approval).toMatchObject({ toolName: 'cancel_order', approvalsRequired: 2 });
      await decide(alice.cookie, approval.id).expect(201);
      expect((await pool.query("SELECT status FROM orders WHERE id = 11")).rows[0].status).toBe('processing');
      await decide(bob.cookie, approval.id).expect(201);
      expect((await pool.query("SELECT status FROM orders WHERE id = 11")).rows[0].status).toBe('cancelled');
    });

    it('stay at one approval by default', async () => {
      await boot({ FOUR_EYES_REFUND_OVER: '10' });
      const alice = await signIn('alice');
      const { approval } = await parkRefund(alice.cookie, 1, CANCEL);
      expect(approval).toMatchObject({ toolName: 'cancel_order', approvalsRequired: 1 });
      await decide(alice.cookie, approval.id).expect(201);
      expect((await pool.query("SELECT status FROM orders WHERE id = 11")).rows[0].status).toBe('cancelled');
    });
  });

  describe('callers without an identity', () => {
    it('demo mode cannot give an approval to a two-approval action, but can reject it', async () => {
      await boot();
      const parkDemo = async () => {
        const conv = (await http().post('/conversations').send({ customerId: 1 }).expect(201)).body;
        await http().post(`/conversations/${conv.id}/messages`).set('X-Conversation-Token', conv.accessToken).send({ content: REFUND }).expect(201);
        return (await http().get('/approvals?status=pending').expect(200)).body[0];
      };
      const approval = await parkDemo();
      expect(approval.approvalsRequired).toBe(2);
      const refused = await http().post(`/approvals/${approval.id}`).send({ decision: 'approve' }).expect(409);
      expect(refused.body.code).toBe('FOUR_EYES_NEEDS_ACCOUNTS');
      expect(await refunds()).toBe(0);
      await http().post(`/approvals/${approval.id}`).send({ decision: 'reject' }).expect(201);
    });

    it('key mode likewise; and its one-approval decisions are logged without a name', async () => {
      await boot({ REVIEWER_API_KEY: 'rev-key', FOUR_EYES_REFUND_OVER: '60' });
      const key = { Authorization: 'Bearer rev-key' };
      const conv = (await http().post('/conversations').send({ customerId: 1 }).expect(201)).body;
      await http().post(`/conversations/${conv.id}/messages`).set('X-Conversation-Token', conv.accessToken).send({ content: REFUND }).expect(201);
      const [approval] = (await http().get('/approvals?status=pending').set(key).expect(200)).body;
      expect(approval.approvalsRequired).toBe(1); // $50 is not over $60
      await http().post(`/approvals/${approval.id}`).set(key).send({ decision: 'approve' }).expect(201);
      const log = (await http().get('/approvals/events').set(key).expect(200)).body;
      expect(log[0]).toMatchObject({ kind: 'approved', actorType: 'reviewer', actorId: null, actorName: null });
    });
  });
});
