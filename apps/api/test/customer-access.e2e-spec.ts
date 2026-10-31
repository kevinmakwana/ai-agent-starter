import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { hashToken, newToken } from '../src/auth/session-token';
import { CUSTOMER_AUTH_STORE, REVIEWER_STORE } from '../src/auth/tokens';
import type { CustomerAuthStore } from '../src/auth/customer.store';
import type { ReviewerStore } from '../src/auth/reviewer.store';
import { PgAgentStore } from '../src/db/pg-agent.store';
import { createPool } from '../src/db/pool';
import { seedDatabase } from '../src/db/seed-data';
import { configureApp } from '../src/http/setup';
import { PG_POOL } from '../src/tokens';

const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

const CSRF = { 'X-Requested-By': 'reviewer-console' };
const LOGIN_ENV = { CUSTOMER_LOGIN: 'true', LOGIN_SMTP_URL: 'smtp://localhost:1025', LOGIN_EMAIL_FROM: 'support@example.com' };
const ENV_KEYS = ['CUSTOMER_LOGIN', 'LOGIN_SMTP_URL', 'LOGIN_EMAIL_FROM', 'REVIEWER_API_KEY', 'CUSTOMER_APP_URL'];
const REFUND = 'Order #1 arrived damaged, please refund it'; // customer 1 owns order 1
const HIDDEN = ['policyRule', 'policyDetail', 'notifiedAt', 'approvalsRequired', 'approvalsGiven', 'approvedBy', 'approvedByIds'];

maybe('customer login: conversation access (e2e, real Postgres)', () => {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let app: INestApplication;
  let pool: Pool;
  let customers: CustomerAuthStore;
  const http = () => request(app.getHttpServer());

  const boot = async (env: Record<string, string> = LOGIN_ENV) => {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    Object.assign(process.env, env);
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    configureApp(app);
    await app.init();
    pool = app.get(PG_POOL);
    customers = app.get(CUSTOMER_AUTH_STORE);
    await seedDatabase(pool);
  };

  /** A signed-in customer's Cookie header, minted without email. */
  const signIn = async (customerId: number) => {
    const token = newToken();
    await customers.createSession(customerId, hashToken(token), 7);
    return `customer_session=${token}`;
  };
  const start = async (cookie: string) => (await http().post('/conversations').set('Cookie', cookie).set(CSRF).send({}).expect(201)).body;

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

  describe('starting a conversation', () => {
    beforeEach(() => boot());

    it('binds it to the signed-in customer, issues no access token, and needs the CSRF header', async () => {
      const ava = await signIn(1);
      await http().post('/conversations').set('Cookie', ava).send({}).expect(403);
      const conv = await start(ava);
      expect(conv).toMatchObject({ customerId: 1, customerName: 'Ava Brooks' });
      expect(conv).not.toHaveProperty('accessToken');
      expect((await pool.query('SELECT access_token_hash FROM conversations WHERE id = $1', [conv.id])).rows[0].access_token_hash).toBeNull();
    });

    it('refuses a customerId or email in the body, and anyone who is not a signed-in customer', async () => {
      const ava = await signIn(1);
      await http().post('/conversations').set('Cookie', ava).set(CSRF).send({ customerId: 2 }).expect(400);
      await http().post('/conversations').set('Cookie', ava).set(CSRF).send({ email: 'ben.carter@example.com' }).expect(400);
      await http().post('/conversations').set(CSRF).send({}).expect(401);
      await http().post('/conversations').set(CSRF).send({ customerId: 1 }).expect(401); // the old open way is closed
      await http().post('/conversations').set('Cookie', 'customer_session=made-up').set(CSRF).send({}).expect(401);
    });
  });

  describe('reading and writing a conversation', () => {
    beforeEach(() => boot());

    it('is open to its own customer only; every other caller gets the identical 401', async () => {
      const [ava, ben] = [await signIn(1), await signIn(2)];
      const conv = await start(ava);
      await http().get(`/conversations/${conv.id}`).set('Cookie', ava).expect(200);
      const unknown = await http().get('/conversations/00000000-0000-4000-8000-000000000000').set('Cookie', ben).expect(401);
      const wrong = await http().get(`/conversations/${conv.id}`).set('Cookie', ben).expect(401);
      const anonymous = await http().get(`/conversations/${conv.id}`).expect(401);
      expect(wrong.body).toEqual(unknown.body);
      expect(anonymous.body).toEqual(unknown.body);
      await http().post(`/conversations/${conv.id}/messages`).set('Cookie', ben).set(CSRF).send({ content: 'hi' }).expect(401);
      await http().post(`/conversations/${conv.id}/messages`).set('Cookie', ava).send({ content: 'hi' }).expect(403); // CSRF
      await http().post(`/conversations/${conv.id}/messages`).set('Cookie', ava).set(CSRF).send({ content: 'Show my recent orders' }).expect(201);
    });

    it('does not accept a conversation token in login mode, even a real one', async () => {
      const legacy = await app.get(PgAgentStore).createConversation(1, 'before login mode');
      await http().get(`/conversations/${legacy.id}`).set('X-Conversation-Token', legacy.accessToken).expect(401);
      const ava = await signIn(1);
      await http().get(`/conversations/${legacy.id}`).set('Cookie', ava).expect(200); // ...but its customer can sign in and read it
      await http().get(`/conversations/${legacy.id}`).set('Cookie', ava).set('X-Conversation-Token', 'wrong').expect(200); // the token is simply ignored
    });

    it('the stream follows the same rule', async () => {
      const [ava, ben] = [await signIn(1), await signIn(2)];
      const conv = await start(ava);
      await app.listen(0);
      const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      expect((await fetch(`${base}/conversations/${conv.id}/events`)).status).toBe(401);
      expect((await fetch(`${base}/conversations/${conv.id}/events`, { headers: { Cookie: ben } })).status).toBe(401);
      const ctrl = new AbortController();
      const ok = await fetch(`${base}/conversations/${conv.id}/events`, { headers: { Cookie: ava }, signal: ctrl.signal });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toContain('text/event-stream');
      ctrl.abort();
      await ok.body?.cancel().catch(() => undefined);
    });
  });

  describe('my conversations', () => {
    beforeEach(() => boot());

    it('lists only the caller\'s own, newest first, in the customer shape; anonymous is 401', async () => {
      const [ava, ben] = [await signIn(1), await signIn(2)];
      const first = await start(ava);
      const second = await start(ava);
      await start(ben);
      const mine = (await http().get('/my/conversations').set('Cookie', ava).expect(200)).body;
      expect(mine.map((c: { id: string }) => c.id)).toEqual([second.id, first.id]);
      expect(Object.keys(mine[0]).sort()).toEqual(['awaitingApproval', 'createdAt', 'id', 'lastStatus', 'title']);
      expect(mine[0]).toMatchObject({ awaitingApproval: false, lastStatus: null });
      await http().get('/my/conversations').expect(401);
    });

    it('shows an earlier conversation made before login mode, and reports one waiting for approval', async () => {
      const legacy = await app.get(PgAgentStore).createConversation(1, 'old chat');
      const ava = await signIn(1);
      const conv = await start(ava);
      await http().post(`/conversations/${conv.id}/messages`).set('Cookie', ava).set(CSRF).send({ content: REFUND }).expect(201);
      const mine = (await http().get('/my/conversations').set('Cookie', ava).expect(200)).body;
      expect(mine.map((c: { id: string }) => c.id).sort()).toEqual([legacy.id, conv.id].sort());
      expect(mine.find((c: { id: string }) => c.id === conv.id)).toMatchObject({ awaitingApproval: true, lastStatus: 'awaiting_approval' });
    });
  });

  describe('a customer is not a reviewer', () => {
    beforeEach(() => boot());

    it('gets 401 on every reviewer route', async () => {
      const ava = await signIn(1);
      for (const path of ['/approvals', '/approvals/events', '/customers', '/conversations', '/events', '/reviewers']) {
        await http().get(path).set('Cookie', ava).expect(401);
      }
      await http().post('/approvals/00000000-0000-4000-8000-000000000000').set('Cookie', ava).set(CSRF).send({ decision: 'approve' }).expect(401);
    });

    it('sees the customer view of a parked approval; a reviewer sees the policy fields', async () => {
      await app.close();
      await boot({ ...LOGIN_ENV, REVIEWER_API_KEY: 'rev-key' });
      const ava = await signIn(1);
      const conv = await start(ava);
      await http().post(`/conversations/${conv.id}/messages`).set('Cookie', ava).set(CSRF).send({ content: REFUND }).expect(201);
      const mine = (await http().get(`/conversations/${conv.id}`).set('Cookie', ava).expect(200)).body;
      expect(mine.approvals).toHaveLength(1);
      for (const key of HIDDEN) expect(mine.approvals[0]).not.toHaveProperty(key);
      const asReviewer = (await http().get(`/conversations/${conv.id}`).set('Authorization', 'Bearer rev-key').expect(200)).body;
      expect(asReviewer.approvals[0]).toHaveProperty('policyRule');
      expect(asReviewer.approvals[0]).toHaveProperty('notifiedAt');
    });
  });

  describe('modes', () => {
    it('the open demo does not let an anonymous caller into conversations, yet a customer session works there', async () => {
      await boot(); // no reviewers, no key: demo reviewer mode
      expect((await http().get('/approvals').expect(200)).body).toBeDefined(); // reviewer routes stay open, as the demo promises
      const ava = await signIn(1);
      const conv = await start(ava);
      await http().get(`/conversations/${conv.id}`).expect(401);
      await http().get(`/conversations/${conv.id}`).set('Cookie', ava).expect(200);
      await http().get('/conversations').expect(200); // still the open demo list for reviewers
    });

    it('a reviewer cookie wins over a customer cookie and sees every conversation', async () => {
      await boot();
      const store: ReviewerStore = app.get(REVIEWER_STORE);
      await store.createReviewer({ email: 'rev@example.com', name: 'Rev', role: 'reviewer', passwordHash: await hashPassword('correct horse battery') });
      const login = await http().post('/auth/login').set(CSRF).send({ email: 'rev@example.com', password: 'correct horse battery' }).expect(200);
      const reviewerCookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      const ava = await signIn(1);
      const conv = await start(ava);
      const both = `${reviewerCookie}; ${ava}`;
      await http().get('/approvals').set('Cookie', both).expect(200);
      await http().get(`/conversations/${conv.id}`).set('Cookie', reviewerCookie).expect(200);
      await http().get('/approvals').set('Cookie', ava).expect(401); // the customer cookie alone is not a reviewer
      await http().get('/conversations').set('Cookie', ava).expect(401);
    });

    it('with login off nothing changes: the old open start works, `{}` is 400, /my/conversations is 401, health says so', async () => {
      await boot({ CUSTOMER_LOGIN: 'false' });
      await http().post('/conversations').send({}).expect(400);
      await http().post('/conversations').send({ customerId: null }).expect(400); // null is not a customer
      const conv = (await http().post('/conversations').send({ customerId: 1 }).expect(201)).body;
      await http().get(`/conversations/${conv.id}`).set('X-Conversation-Token', conv.accessToken).expect(200);
      await http().get('/my/conversations').expect(401);
      expect((await http().get('/health').expect(200)).body).toMatchObject({ customerLogin: false });
    });

    it('health says customer login is on', async () => {
      await boot();
      expect((await http().get('/health').expect(200)).body).toMatchObject({ customerLogin: true });
    });
  });
});
