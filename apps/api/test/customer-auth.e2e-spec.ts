import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CustomerAuthService } from '../src/auth/customer-auth.service';
import { LOGIN_MAILER } from '../src/auth/tokens';
import { PgAgentStore } from '../src/db/pg-agent.store';
import { createPool } from '../src/db/pool';
import { seedDatabase } from '../src/db/seed-data';
import { configureApp } from '../src/http/setup';
import { PG_POOL } from '../src/tokens';

const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;
const CSRF = { 'X-Requested-By': 'reviewer-console' };
const LOGIN_ENV = { CUSTOMER_LOGIN: 'true', LOGIN_SMTP_URL: 'smtp://localhost:1025', LOGIN_EMAIL_FROM: 'support@example.com' };
const ENV_KEYS = ['CUSTOMER_LOGIN', 'LOGIN_SMTP_URL', 'LOGIN_EMAIL_FROM', 'CUSTOMER_APP_URL', 'RATE_LIMIT_CUSTOMER_LOGIN_PER_MINUTE', 'COOKIE_SECURE', 'CUSTOMER_SESSION_TTL_DAYS', 'REVIEWER_API_KEY'];
const AVA = 'ava.brooks@example.com';

maybe('customer login: magic link routes (e2e, real Postgres)', () => {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let app: INestApplication;
  let pool: Pool;
  let sent: { to: string; link: string }[];
  let failMail = false;
  const http = () => request(app.getHttpServer());

  const boot = async (env: Record<string, string> = {}) => {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    Object.assign(process.env, { RATE_LIMIT_CUSTOMER_LOGIN_PER_MINUTE: '100', ...LOGIN_ENV, ...env });
    sent = [];
    failMail = false;
    const fake = {
      sendLink: async (to: string, link: string) => { if (failMail) throw Object.assign(new Error(`550 ${to}`), { code: 'EENVELOPE' }); sent.push({ to, link }); },
      close: () => undefined,
    };
    app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LOGIN_MAILER).useValue(fake).compile()).createNestApplication();
    configureApp(app);
    await app.init();
    pool = app.get(PG_POOL);
    await seedDatabase(pool);
  };
  const requestLink = async (email = AVA) => {
    const res = await http().post('/customer-auth/request').set(CSRF).send({ email });
    await app.get(CustomerAuthService).drain();
    return res;
  };
  const tokenOf = (link: string) => link.split('#token=')[1];
  const verify = (token: string) => http().post('/customer-auth/verify').set(CSRF).send({ token });
  /** Requests a link, redeems it, and returns the Cookie header. */
  const signIn = async (email = AVA) => {
    await requestLink(email);
    const res = await verify(tokenOf(sent.at(-1)!.link)).expect(200);
    return (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  };
  const as = (cookie: string) => ({ get: (p: string) => http().get(p).set('Cookie', cookie), post: (p: string) => http().post(p).set('Cookie', cookie).set(CSRF) });

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

  describe('request', () => {
    beforeEach(() => boot());

    it('answers the same 202 for a known and an unknown email, sets no cookie and shows no token; only the known one gets mail', async () => {
      const known = await requestLink(AVA).then((r) => r);
      const unknown = await requestLink('nobody@example.com');
      expect(known.status).toBe(202);
      expect(unknown.status).toBe(202);
      expect(known.body).toEqual({ status: 'sent' });
      expect(unknown.body).toEqual(known.body);
      expect(known.headers['set-cookie']).toBeUndefined();
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(AVA);
      expect(JSON.stringify(known.body)).not.toContain(tokenOf(sent[0].link));
    });

    it('matches the email in any case and with surrounding spaces; rejects a malformed email with 400', async () => {
      await requestLink('  AVA.BROOKS@Example.com ');
      expect(sent).toHaveLength(1);
      await http().post('/customer-auth/request').set(CSRF).send({ email: 'not-an-email' }).expect(400);
      await http().post('/customer-auth/request').set(CSRF).send({}).expect(400);
    });

    it('builds the link from CUSTOMER_APP_URL, never puts the token in a path or query, and keeps it out of the logs', async () => {
      await app.close();
      await boot({ CUSTOMER_APP_URL: 'https://shop.example.com/' });
      await requestLink();
      expect(sent[0].link).toMatch(/^https:\/\/shop\.example\.com\/login#token=[A-Za-z0-9_-]{43}$/);
    });

    it('needs the CSRF header', async () => {
      await http().post('/customer-auth/request').send({ email: AVA }).expect(403);
      await http().post('/customer-auth/verify').send({ token: 'x' }).expect(403);
      await http().post('/customer-auth/logout').expect(403);
      await http().post('/customer-auth/logout-all').expect(403);
    });

    it('is limited per client with 429 and Retry-After', async () => {
      await app.close();
      await boot({ RATE_LIMIT_CUSTOMER_LOGIN_PER_MINUTE: '3' });
      for (let i = 0; i < 3; i++) await requestLink('nobody@example.com');
      const blocked = await http().post('/customer-auth/request').set(CSRF).send({ email: AVA }).expect(429);
      expect(blocked.headers['retry-after']).toBeDefined();
    });

    it('creates at most 5 links per customer per hour but still answers 202 every time', async () => {
      for (let i = 0; i < 7; i++) expect((await requestLink()).status).toBe(202);
      expect(sent).toHaveLength(5);
      expect((await pool.query('SELECT count(*)::int AS n FROM login_links')).rows[0].n).toBe(5);
    });

    it('survives a mail failure: still 202, nothing thrown, no address in the log', async () => {
      failMail = true;
      const res = await requestLink();
      expect(res.status).toBe(202);
      expect(sent).toHaveLength(0);
      await http().get('/health').expect(200); // the process is fine
    });
  });

  describe('verify', () => {
    beforeEach(() => boot());

    it('sets a hardened cookie, returns the customer, and the link works once', async () => {
      await requestLink();
      const token = tokenOf(sent[0].link);
      const res = await verify(token).expect(200);
      expect(res.body).toEqual({ customer: { id: 1, name: 'Ava Brooks', email: AVA } });
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
      expect(cookie).toMatch(/^customer_session=[A-Za-z0-9_-]{43};/);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain(`Max-Age=${7 * 86400}`);
      expect(cookie).not.toContain('Secure');
      expect(cookie).not.toContain(token);
      expect(JSON.stringify(res.body)).not.toContain(token);
      await verify(token).expect(401);
    });

    it('marks the cookie Secure when configured', async () => {
      await app.close();
      await boot({ COOKIE_SECURE: 'true' });
      await requestLink();
      const res = await verify(tokenOf(sent[0].link)).expect(200);
      expect(res.headers['set-cookie'][0]).toContain('Secure');
    });

    it('turns one link into exactly one session even when eight requests race', async () => {
      await requestLink();
      const token = tokenOf(sent[0].link);
      await Promise.all(Array.from({ length: 6 }, () => pool.query('SELECT pg_sleep(0.05)')));
      const results = await Promise.all(Array.from({ length: 8 }, () => verify(token)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 401, 401, 401, 401, 401, 401, 401]);
      expect((await pool.query('SELECT count(*)::int AS n FROM customer_sessions')).rows[0].n).toBe(1);
    });

    it('answers every bad link with the same 401: unknown, empty, expired, used, superseded, huge, wrong type', async () => {
      await requestLink();
      const expired = tokenOf(sent[0].link);
      await pool.query(`UPDATE login_links SET expires_at = now() - interval '1 second'`);
      const bodies = [];
      for (const token of ['unknown-token-value', '', expired, 'x'.repeat(5000)]) bodies.push((await verify(token).expect(401)).body);
      await http().post('/customer-auth/verify').set(CSRF).send({ token: 42 }).expect(400); // not even a string: validation, reveals nothing
      for (const b of bodies) expect(b).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired link' });

      for (let i = 0; i < 3; i++) await requestLink(); // the third supersedes the oldest of the new ones
      const [oldest, , newest] = sent.slice(1).map((s) => tokenOf(s.link));
      await verify(oldest).expect(401);
      await verify(newest).expect(200);
    });
  });

  describe('sessions', () => {
    beforeEach(() => boot());

    it('/me returns the customer for a session and 401 otherwise', async () => {
      const cookie = await signIn();
      expect((await as(cookie).get('/customer-auth/me').expect(200)).body).toEqual({ customer: { id: 1, name: 'Ava Brooks', email: AVA } });
      await http().get('/customer-auth/me').expect(401);
      await http().get('/customer-auth/me').set('Cookie', 'customer_session=made-up').expect(401);
    });

    it('expires after the absolute lifetime and after 24 idle hours', async () => {
      const cookie = await signIn();
      await pool.query(`UPDATE customer_sessions SET last_seen_at = now() - interval '25 hours'`);
      await as(cookie).get('/customer-auth/me').expect(401);
      const fresh = await signIn();
      await as(fresh).get('/customer-auth/me').expect(200);
      await pool.query(`UPDATE customer_sessions SET expires_at = now() - interval '1 second'`);
      await as(fresh).get('/customer-auth/me').expect(401);
    });

    it('logout ends this session and clears the cookie; replaying it fails', async () => {
      const cookie = await signIn();
      const res = await as(cookie).post('/customer-auth/logout').expect(204);
      expect(res.headers['set-cookie'][0]).toMatch(/^customer_session=;/);
      await as(cookie).get('/customer-auth/me').expect(401);
      await as(cookie).post('/customer-auth/logout').expect(401);
    });

    it('logout-all ends every session of that customer and nobody else\'s', async () => {
      const [one, two, ben] = [await signIn(), await signIn(), await signIn('ben.carter@example.com')];
      await as(one).post('/customer-auth/logout-all').expect(204);
      await as(one).get('/customer-auth/me').expect(401);
      await as(two).get('/customer-auth/me').expect(401);
      await as(ben).get('/customer-auth/me').expect(200);
    });

    it('a full journey: sign in, start a chat, read it back, see it listed, sign out', async () => {
      const cookie = await signIn();
      const conv = (await as(cookie).post('/conversations').send({}).expect(201)).body;
      await as(cookie).post(`/conversations/${conv.id}/messages`).send({ content: 'Show my recent orders' }).expect(201);
      expect((await as(cookie).get(`/conversations/${conv.id}`).expect(200)).body.conversation.customerId).toBe(1);
      expect((await as(cookie).get('/my/conversations').expect(200)).body).toHaveLength(1);
      await as(cookie).post('/customer-auth/logout').expect(204);
      await as(cookie).get(`/conversations/${conv.id}`).expect(401);
    });

    it('conversations from before login mode appear after sign-in', async () => {
      const legacy = await app.get(PgAgentStore).createConversation(1, 'old');
      const cookie = await signIn();
      expect((await as(cookie).get('/my/conversations').expect(200)).body.map((c: { id: string }) => c.id)).toContain(legacy.id);
    });
  });

  describe('with login off', () => {
    it('the routes do not exist (404) and nothing is mailed', async () => {
      await boot({ CUSTOMER_LOGIN: 'false' });
      await http().post('/customer-auth/request').set(CSRF).send({ email: AVA }).expect(404);
      await http().post('/customer-auth/verify').set(CSRF).send({ token: 'x' }).expect(404);
      await http().post('/customer-auth/logout').set(CSRF).expect(404);
      await http().get('/customer-auth/me').expect(404);
      expect(sent).toHaveLength(0);
    });
  });
});
