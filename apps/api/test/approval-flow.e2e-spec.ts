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
      await http().get('/health').expect(200).expect({ status: 'ok', db: 'up', provider: 'mock', reviewerAuth: false });
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

    it('starts a conversation by customer email (case-insensitive)', async () => {
      const res = await http().post('/conversations').send({ email: 'AVA.BROOKS@example.com' }).expect(201);
      expect(res.body).toMatchObject({ customerId: 1, accessToken: expect.any(String) });
      await http().post('/conversations').send({ email: 'nobody@example.com' }).expect(404);
      await http().post('/conversations').send({}).expect(400);
      await http().post('/conversations').send({ email: 'not-an-email' }).expect(400);
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
    const reviewer = { Authorization: 'Bearer s3cret' };
    beforeEach(() => { process.env.REVIEWER_API_KEY = 's3cret'; return boot(); });
    afterEach(() => { delete process.env.REVIEWER_API_KEY; });

    const start = async (customerId: number) => {
      const res = await http().post('/conversations').send({ customerId }).expect(201);
      return { id: res.body.id as string, token: { 'X-Conversation-Token': res.body.accessToken as string } };
    };

    it('locks reviewer routes behind the key', async () => {
      await http().get('/health').expect(200).expect((r) => expect(r.body.reviewerAuth).toBe(true));
      for (const path of ['/approvals', '/customers', '/conversations']) {
        await http().get(path).expect(401);
        await http().get(path).set('Authorization', 'Bearer wrong').expect(401);
        await http().get(path).set(reviewer).expect(200);
      }
      await http().post('/approvals/00000000-0000-4000-8000-000000000000').send({ decision: 'approve' }).expect(401);
    });

    it('only the token holder (or a reviewer) can read or write a conversation', async () => {
      const mine = await start(1);
      const other = await start(2);

      await http().get(`/conversations/${mine.id}`).expect(401);
      await http().get(`/conversations/${mine.id}`).set(other.token).expect(401); // someone else's token
      await http().post(`/conversations/${mine.id}/messages`).set(other.token).send({ content: 'hi' }).expect(401);
      await http().get('/conversations/00000000-0000-4000-8000-000000000000').set(mine.token).expect(401); // no id probing

      await http().get(`/conversations/${mine.id}`).set(mine.token).expect(200);
      await http().post(`/conversations/${mine.id}/messages`).set(mine.token).send({ content: 'refund order #1' }).expect(201);
      await http().get(`/conversations/${mine.id}`).set(reviewer).expect(200); // reviewers can read any trace
    });

    it('only stores a hash of the token and never returns it again', async () => {
      const mine = await start(1);
      const { rows } = await pool.query('SELECT access_token_hash FROM conversations WHERE id = $1', [mine.id]);
      expect(rows[0].access_token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].access_token_hash).not.toBe(mine.token['X-Conversation-Token']);
      const trace = await http().get(`/conversations/${mine.id}`).set(mine.token).expect(200);
      expect(JSON.stringify(trace.body)).not.toContain(mine.token['X-Conversation-Token']);
    });

    it('lets a reviewer approve while the customer cannot', async () => {
      const mine = await start(1);
      await http().post(`/conversations/${mine.id}/messages`).set(mine.token).send({ content: 'refund order #1' }).expect(201);
      const [approval] = (await http().get('/approvals?status=pending').set(reviewer)).body;
      await http().post(`/approvals/${approval.id}`).set(mine.token).send({ decision: 'approve' }).expect(401); // token != reviewer
      await http().post(`/approvals/${approval.id}`).set(reviewer).send({ decision: 'approve' }).expect(201);
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
