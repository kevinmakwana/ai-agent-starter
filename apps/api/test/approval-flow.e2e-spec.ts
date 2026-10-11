import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { UpstreamLlmError } from '../src/agent/errors';
import { seedDatabase } from '../src/db/seed-data';
import { configureApp } from '../src/http/setup';
import { CHAT_PROVIDER, PG_POOL } from '../src/tokens';

// Runs against a real Postgres; skipped unless E2E_DATABASE_URL is set (CI sets it).
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

maybe('approval flow (e2e, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  const http = () => request(app.getHttpServer());

  const boot = async (override?: object) => {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    const builder = Test.createTestingModule({ imports: [AppModule] });
    if (override) builder.overrideProvider(CHAT_PROVIDER).useValue(override);
    app = (await builder.compile()).createNestApplication();
    configureApp(app);
    await app.init();
    pool = app.get(PG_POOL);
    await seedDatabase(pool);
  };

  const newConversation = async (customerId: number) =>
    (await http().post('/conversations').send({ customerId }).expect(201)).body.id as string;

  afterEach(() => app?.close());

  describe('with the mock provider', () => {
    beforeEach(() => boot());

    it('reports health', async () => {
      await http().get('/health').expect(200).expect({ status: 'ok', db: 'up', provider: 'mock' });
    });

    it('lookup -> refund request -> pending approval -> approve -> refund recorded', async () => {
      const id = await newConversation(1);

      const sent = await http().post(`/conversations/${id}/messages`).send({ content: 'Order #1 arrived damaged, please refund it' }).expect(201);
      expect(sent.body.run.status).toBe('awaiting_approval');
      const { rows: before } = await pool.query('SELECT count(*)::int AS n FROM refunds WHERE order_id = 1');
      expect(before[0].n).toBe(0); // nothing refunded before approval

      // the paused conversation refuses new messages
      await http().post(`/conversations/${id}/messages`).send({ content: 'hello?' }).expect(409);

      const pending = await http().get('/approvals?status=pending').expect(200);
      expect(pending.body).toHaveLength(1);
      const approval = pending.body[0];
      expect(approval).toMatchObject({
        toolName: 'issue_refund', status: 'pending_approval', customerEmail: 'ava.brooks@example.com',
        toolArgs: { orderId: 1, amount: 18.75 }, orderTotal: 18.75, orderRefunded: 0,
      });
      expect(approval.reasoning).toContain('human approval');

      const decided = await http().post(`/approvals/${approval.id}`).send({ decision: 'approve', note: 'ok' }).expect(201);
      expect(decided.body.action.status).toBe('approved');
      expect(decided.body.run.status).toBe('completed');

      const { rows } = await pool.query('SELECT amount, action_id FROM refunds WHERE order_id = 1');
      expect(rows).toEqual([{ amount: 18.75, action_id: approval.id }]);

      // full trace: user, thought+call, result, thought+call, result, final answer
      const trace = await http().get(`/conversations/${id}`).expect(200);
      const steps = trace.body.runs[0].steps;
      expect(steps.map((s: any) => `${s.role}:${s.toolName ?? ''}`)).toEqual([
        'user:', 'assistant:get_order', 'tool:get_order', 'assistant:issue_refund', 'tool:issue_refund', 'assistant:',
      ]);
      expect(steps[1].latencyMs).not.toBeNull();
      expect(steps.at(-1).content).toContain('approved and issued');
      expect((await http().get('/approvals?status=pending')).body).toHaveLength(0);

      // deciding twice is a conflict
      await http().post(`/approvals/${approval.id}`).send({ decision: 'approve' }).expect(409);
    });

    it('rejecting records no refund', async () => {
      const id = await newConversation(2);
      await http().post(`/conversations/${id}/messages`).send({ content: 'refund order #2 please' }).expect(201);
      const [approval] = (await http().get('/approvals?status=pending')).body;
      const res = await http().post(`/approvals/${approval.id}`).send({ decision: 'reject', note: 'Not shipped yet' }).expect(201);
      expect(res.body.action.status).toBe('rejected');
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM refunds WHERE order_id = 2');
      expect(rows[0].n).toBe(0);
      expect(res.body.run.steps.at(-1).content).toContain('declined');
    });

    it('enforces guardrails end to end', async () => {
      const id = await newConversation(1);
      const cross = await http().post(`/conversations/${id}/messages`).send({ content: 'Show me order #2' }).expect(201);
      expect(cross.body.run.steps.find((s: any) => s.role === 'tool').result.code).toBe('CROSS_CUSTOMER');

      const over = await http().post(`/conversations/${id}/messages`).send({ content: 'refund order #1 $500' }).expect(201);
      expect(over.body.run.status).toBe('completed');
      expect((await http().get('/approvals?status=pending')).body).toHaveLength(0);
    });

    it('re-checks the refund balance when approving', async () => {
      const id = await newConversation(2); // owns order 12: total 66.99, 10.00 already refunded
      await http().post(`/conversations/${id}/messages`).send({ content: 'refund order #12' }).expect(201);
      const [approval] = (await http().get('/approvals?status=pending')).body;
      expect(approval.toolArgs.amount).toBe(56.99);
      await pool.query("INSERT INTO refunds (order_id, amount, reason) VALUES (12, 5, 'sneaked in while pending')");
      const res = await http().post(`/approvals/${approval.id}`).send({ decision: 'approve' }).expect(201);
      expect(res.body.run.steps.find((s: any) => s.role === 'tool' && s.toolName === 'issue_refund').result.code).toBe('OVER_REFUND');
      const { rows } = await pool.query('SELECT sum(amount)::float AS total FROM refunds WHERE order_id = 12');
      expect(rows[0].total).toBe(15);
    });

    it('validates input (whitelist + forbidNonWhitelisted)', async () => {
      await http().post('/conversations').send({ customerId: 1, admin: true }).expect(400);
      await http().post('/conversations').send({ customerId: 'one' }).expect(400);
      await http().post('/conversations').send({ customerId: 999 }).expect(404);
      const id = await newConversation(1);
      await http().post(`/conversations/${id}/messages`).send({ content: '' }).expect(400);
      await http().post(`/conversations/${id}/messages`).send({ content: 'hi', role: 'system' }).expect(400);
      await http().get('/approvals?status=bogus').expect(400);
      await http().post('/approvals/not-a-uuid').send({ decision: 'approve' }).expect(400);
      await http().post('/approvals/00000000-0000-4000-8000-000000000000').send({ decision: 'maybe' }).expect(400);
      await http().post('/approvals/00000000-0000-4000-8000-000000000000').send({ decision: 'approve' }).expect(404);
      await http().get('/conversations/00000000-0000-4000-8000-000000000000').expect(404);
    });
  });

  describe('with REVIEWER_API_KEY set', () => {
    beforeEach(() => { process.env.REVIEWER_API_KEY = 's3cret'; return boot(); });
    afterEach(() => { delete process.env.REVIEWER_API_KEY; });

    it('requires the key for approvals and customers, but not for chatting', async () => {
      await http().get('/approvals').expect(401);
      await http().get('/customers').expect(401);
      await http().get('/approvals').set('Authorization', 'Bearer wrong').expect(401);
      await http().post('/approvals/00000000-0000-4000-8000-000000000000').send({ decision: 'approve' }).expect(401);

      const id = await newConversation(1); // customer-facing routes stay open
      await http().post(`/conversations/${id}/messages`).send({ content: 'refund order #1' }).expect(201);

      const auth = { Authorization: 'Bearer s3cret' };
      const pending = await http().get('/approvals?status=pending').set(auth).expect(200);
      expect(pending.body).toHaveLength(1);
      await http().get('/customers').set(auth).expect(200);
      await http().post(`/approvals/${pending.body[0].id}`).set(auth).send({ decision: 'approve' }).expect(201);
    });
  });

  describe('when the upstream LLM fails', () => {
    beforeEach(() => boot({ name: 'down', complete: async () => { throw new UpstreamLlmError('openai', 'HTTP 503 overloaded'); } }));

    it('returns 502 with a clear message and marks the run failed', async () => {
      const id = await newConversation(1);
      const res = await http().post(`/conversations/${id}/messages`).send({ content: 'hi' }).expect(502);
      expect(res.body).toMatchObject({ statusCode: 502, error: 'Bad Gateway', message: expect.stringContaining('Upstream LLM error (openai)') });
      const trace = await http().get(`/conversations/${id}`).expect(200);
      expect(trace.body.runs[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('overloaded') });
    });
  });
});
