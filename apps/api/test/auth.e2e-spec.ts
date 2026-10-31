import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import type { ReviewerStore } from '../src/auth/reviewer.store';
import { REVIEWER_STORE } from '../src/auth/tokens';
import { createPool } from '../src/db/pool';
import { seedDatabase } from '../src/db/seed-data';
import { configureApp } from '../src/http/setup';
import { PG_POOL } from '../src/tokens';

// Runs against a real Postgres; skipped unless E2E_DATABASE_URL is set (CI sets it).
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

const PW = 'correct horse battery';
const CSRF = { 'X-Requested-By': 'reviewer-console' };
const ENV_KEYS = ['REVIEWER_API_KEY', 'COOKIE_SECURE', 'RATE_LIMIT_LOGIN_PER_MINUTE', 'SESSION_TTL_HOURS', 'NODE_ENV'];

maybe('reviewer accounts: login, sessions, admin routes (e2e, real Postgres)', () => {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let app: INestApplication;
  let pool: Pool;
  let store: ReviewerStore;
  const http = () => request(app.getHttpServer());

  const boot = async (env: Record<string, string> = {}) => {
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

  const addReviewer = async (email: string, role: 'admin' | 'reviewer' = 'reviewer', password = PW) =>
    store.createReviewer({ email, name: email.split('@')[0], role, passwordHash: await hashPassword(password) });

  const rawLogin = (email: string, password = PW) => http().post('/auth/login').set(CSRF).send({ email, password });

  /** Logs in and returns the Cookie header value for later requests. */
  const login = async (email: string, password = PW) => {
    const res = await rawLogin(email, password).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  };

  const as = (cookie: string) => ({
    get: (path: string) => http().get(path).set('Cookie', cookie),
    post: (path: string) => http().post(path).set('Cookie', cookie).set(CSRF),
    patch: (path: string) => http().patch(path).set('Cookie', cookie).set(CSRF),
  });

  afterEach(async () => {
    await app?.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });
  afterAll(async () => {
    // leave the database as other suites expect it: seeded, no reviewers (demo mode)
    const cleanup = createPool(process.env.E2E_DATABASE_URL!);
    await seedDatabase(cleanup);
    await cleanup.end();
  });

  describe('login, me and logout', () => {
    beforeEach(() => boot());

    it('logs in with a hardened cookie, returns the reviewer without secrets, and serves /auth/me', async () => {
      await addReviewer('alex@example.com', 'admin');
      const res = await rawLogin('Alex@Example.com').expect(200);
      expect(res.body).toEqual({ reviewer: expect.objectContaining({ email: 'alex@example.com', name: 'alex', role: 'admin', active: true }) });
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
      expect(cookie).toMatch(/^reviewer_session=[A-Za-z0-9_-]{43};/);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/');
      expect(cookie).toMatch(/Max-Age=43200/);
      expect(cookie).not.toContain('Secure');

      const me = await http().get('/auth/me').set('Cookie', cookie.split(';')[0]).expect(200);
      expect(me.body.reviewer.email).toBe('alex@example.com');
    });

    it('marks the cookie Secure when configured, and in production by default', async () => {
      await app.close(); // replace the app the default beforeEach booted
      await boot({ COOKIE_SECURE: 'true' });
      await addReviewer('alex@example.com');
      expect((await rawLogin('alex@example.com').expect(200)).headers['set-cookie'][0]).toContain('Secure');
      await app.close();
      delete process.env.COOKIE_SECURE;
      await boot({ NODE_ENV: 'production' });
      await addReviewer('alex@example.com');
      expect((await rawLogin('alex@example.com').expect(200)).headers['set-cookie'][0]).toContain('Secure');
    });

    it('issues a new token at every login (no session fixation)', async () => {
      await addReviewer('alex@example.com');
      const a = await login('alex@example.com');
      const b = await login('alex@example.com');
      expect(a).not.toBe(b);
    });

    it('/auth/me is 401 without a session or with a made-up one', async () => {
      await addReviewer('alex@example.com');
      await http().get('/auth/me').expect(401);
      await http().get('/auth/me').set('Cookie', 'reviewer_session=made-up').expect(401);
    });

    it('logout ends the session and clears the cookie; replaying the old cookie fails', async () => {
      await addReviewer('alex@example.com');
      const cookie = await login('alex@example.com');
      const res = await as(cookie).post('/auth/logout').expect(204);
      expect(res.headers['set-cookie'][0]).toMatch(/^reviewer_session=;/);
      await as(cookie).get('/auth/me').expect(401);
      await as(cookie).get('/approvals').expect(401);
    });

    it('answers every failure with the same 401 body: unknown, wrong password, inactive, locked', async () => {
      await addReviewer('alex@example.com');
      const off = await addReviewer('off@example.com');
      await store.updateReviewer(off.id, { active: false });
      await addReviewer('locked@example.com');
      for (let i = 0; i < 5; i++) await rawLogin('locked@example.com', 'wrong password!!').expect(401);

      const bodies: unknown[] = [];
      for (const [email, pw] of [['nobody@example.com', PW], ['alex@example.com', 'wrong password!!'], ['off@example.com', PW], ['locked@example.com', PW]]) {
        const res = await rawLogin(email, pw).expect(401);
        expect(res.headers['set-cookie']).toBeUndefined();
        bodies.push(res.body);
      }
      expect(bodies.every((b) => JSON.stringify(b) === JSON.stringify(bodies[0]))).toBe(true);
      expect(bodies[0]).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Invalid email or password' });
    });

    it('locks an account for 15 minutes after 5 failures, then lets the right password in', async () => {
      await addReviewer('alex@example.com');
      for (let i = 0; i < 5; i++) await rawLogin('alex@example.com', 'wrong password!!').expect(401);
      await rawLogin('alex@example.com').expect(401);
      await pool.query(`UPDATE reviewers SET locked_until = now() - interval '1 second'`);
      await rawLogin('alex@example.com').expect(200);
    });

    it('rate limits the login route per client', async () => {
      await app.close();
      await boot({ RATE_LIMIT_LOGIN_PER_MINUTE: '3' });
      for (let i = 0; i < 3; i++) await rawLogin('nobody@example.com').expect(401);
      const blocked = await rawLogin('nobody@example.com').expect(429);
      expect(blocked.headers['retry-after']).toBeDefined();
    });

    it('rejects malformed input with a 400 that never echoes the password', async () => {
      const secret = 'S3cret-Pass-phrase-xyz';
      for (const body of [{ email: 'not-an-email', password: secret }, { email: 'a@b.co', password: secret, extra: 1 }, { email: 'a@b.co', password: secret.repeat(20) }]) {
        const res = await http().post('/auth/login').set(CSRF).send(body).expect(400);
        expect(JSON.stringify(res.body)).not.toContain(secret);
      }
    });
  });

  describe('session lifetime', () => {
    beforeEach(() => boot());

    it('expires after the absolute lifetime and after 30 idle minutes', async () => {
      await addReviewer('alex@example.com');
      const cookie = await login('alex@example.com');
      await as(cookie).get('/auth/me').expect(200);
      await pool.query(`UPDATE reviewer_sessions SET last_seen_at = now() - interval '31 minutes'`);
      await as(cookie).get('/auth/me').expect(401);

      const fresh = await login('alex@example.com');
      await as(fresh).get('/auth/me').expect(200);
      await pool.query(`UPDATE reviewer_sessions SET expires_at = now() - interval '1 second'`);
      await as(fresh).get('/auth/me').expect(401);
    });

    it('deactivating a reviewer ends their sessions at once', async () => {
      const admin = await addReviewer('admin@example.com', 'admin');
      const bob = await addReviewer('bob@example.com');
      const adminCookie = await login('admin@example.com');
      const bobCookie = await login('bob@example.com');
      await as(bobCookie).get('/approvals').expect(200);
      await as(adminCookie).patch(`/reviewers/${bob.id}`).send({ active: false }).expect(200);
      await as(bobCookie).get('/approvals').expect(401);
      await rawLogin('bob@example.com').expect(401);
      expect(admin.id).toBeDefined();
    });

    it('a password change keeps this session, ends the others, and the old password stops working', async () => {
      await addReviewer('alex@example.com');
      const one = await login('alex@example.com');
      const two = await login('alex@example.com');
      await as(one).post('/auth/password').send({ current: 'wrong current pw!', next: 'a brand new password' }).expect(400);
      await as(one).post('/auth/password').send({ current: PW, next: 'short' }).expect(400);
      await as(one).post('/auth/password').send({ current: PW, next: 'a brand new password' }).expect(204);
      await as(one).get('/auth/me').expect(200);
      await as(two).get('/auth/me').expect(401);
      await rawLogin('alex@example.com', PW).expect(401);
      await rawLogin('alex@example.com', 'a brand new password').expect(200);
    });
  });

  describe('CSRF', () => {
    beforeEach(() => boot());

    it('refuses cookie mutations without X-Requested-By (logout, password, approvals, admin) but not reads', async () => {
      const admin = await addReviewer('admin@example.com', 'admin');
      const cookie = await login('admin@example.com');
      const bare = (method: 'post' | 'patch', path: string) => http()[method](path).set('Cookie', cookie);
      await bare('post', '/auth/logout').expect(403);
      await bare('post', '/auth/password').send({ current: PW, next: 'a brand new password' }).expect(403);
      await bare('post', '/approvals/00000000-0000-4000-8000-000000000000').send({ decision: 'reject' }).expect(403);
      await bare('post', '/reviewers').send({ email: 'x@example.com', name: 'X', role: 'reviewer', password: PW }).expect(403);
      await bare('patch', `/reviewers/${admin.id}`).send({ name: 'Y' }).expect(403);
      await as(cookie).get('/approvals').expect(200);
      await as(cookie).get('/reviewers').expect(200);
      await http().post('/approvals/00000000-0000-4000-8000-000000000000').set('Cookie', cookie).set('X-Requested-By', 'something-else').send({ decision: 'reject' }).expect(403);
      // with the header the request reaches the route (an unknown approval is a 404)
      await as(cookie).post('/approvals/00000000-0000-4000-8000-000000000000').send({ decision: 'reject' }).expect(404);
    });

    it('also protects a reviewer sending a customer message with only the cookie', async () => {
      await addReviewer('admin@example.com', 'admin');
      const cookie = await login('admin@example.com');
      const conv = (await http().post('/conversations').send({ customerId: 1 }).expect(201)).body.id;
      await http().post(`/conversations/${conv}/messages`).set('Cookie', cookie).send({ content: 'hi' }).expect(403);
    });
  });

  describe('modes', () => {
    it('key mode keeps working and needs no CSRF header; the key stops working once a reviewer exists', async () => {
      await boot({ REVIEWER_API_KEY: 'rev-key' });
      await http().get('/approvals').expect(401);
      await http().get('/approvals').set('Authorization', 'Bearer rev-key').expect(200);
      await http().post('/approvals/00000000-0000-4000-8000-000000000000').set('Authorization', 'Bearer rev-key').send({ decision: 'reject' }).expect(404);
      expect((await http().get('/health').expect(200)).body).toMatchObject({ reviewerAuth: true, reviewerAccounts: false });

      await addReviewer('alex@example.com', 'admin'); // same process: the mode flips immediately
      await http().get('/approvals').set('Authorization', 'Bearer rev-key').expect(401);
      await http().get('/conversations').set('Authorization', 'Bearer rev-key').expect(401);
      expect((await http().get('/health').expect(200)).body).toMatchObject({ reviewerAuth: true, reviewerAccounts: true });
      const cookie = await login('alex@example.com');
      await as(cookie).get('/approvals').expect(200);
    });

    it('demo mode is open and reports no accounts', async () => {
      await boot();
      await http().get('/approvals').expect(200);
      expect((await http().get('/health').expect(200)).body).toMatchObject({ reviewerAuth: false, reviewerAccounts: false });
    });

    it('customers keep using their conversation token once accounts exist, and only on their own conversation', async () => {
      await boot();
      await addReviewer('alex@example.com');
      const a = (await http().post('/conversations').send({ customerId: 1 }).expect(201)).body;
      const b = (await http().post('/conversations').send({ customerId: 2 }).expect(201)).body;
      await http().get(`/conversations/${a.id}`).set('X-Conversation-Token', a.accessToken).expect(200);
      await http().get(`/conversations/${b.id}`).set('X-Conversation-Token', a.accessToken).expect(401);
      await http().get(`/conversations/${a.id}`).expect(401);
      await http().get('/approvals').set('X-Conversation-Token', a.accessToken).expect(401);
      const cookie = await login('alex@example.com');
      await as(cookie).get(`/conversations/${b.id}`).expect(200);
    });
  });

  describe('server-sent events', () => {
    it('/events opens with the cookie in accounts mode and is 401 without it', async () => {
      await boot();
      await addReviewer('alex@example.com');
      const cookie = await login('alex@example.com');
      await app.listen(0);
      const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      const anon = await fetch(`${base}/events`);
      expect(anon.status).toBe(401);
      const ctrl = new AbortController();
      const ok = await fetch(`${base}/events`, { headers: { Cookie: cookie }, signal: ctrl.signal });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toContain('text/event-stream');
      ctrl.abort();
      await ok.body?.cancel().catch(() => undefined);
    });
  });

  describe('admin routes', () => {
    beforeEach(() => boot());

    it('lets an admin list, add and edit reviewers; views never carry secrets', async () => {
      await addReviewer('admin@example.com', 'admin');
      const cookie = await login('admin@example.com');
      const created = await as(cookie).post('/reviewers').send({ email: 'New@Example.com', name: 'New Person', role: 'reviewer', password: PW }).expect(201);
      expect(created.body).toEqual({
        id: expect.any(String), email: 'new@example.com', name: 'New Person', role: 'reviewer', active: true,
        createdAt: expect.any(String), lastLoginAt: null,
      });
      await as(cookie).post('/reviewers').send({ email: 'new@example.com', name: 'Dup', role: 'reviewer', password: PW }).expect(409)
        .expect((r) => expect(r.body.code).toBe('EMAIL_TAKEN'));
      await as(cookie).post('/reviewers').send({ email: 'weak@example.com', name: 'Weak', role: 'reviewer', password: 'short' }).expect(400);
      await as(cookie).post('/reviewers').send({ email: 'x@example.com', name: 'X', role: 'owner', password: PW }).expect(400);

      const patched = await as(cookie).patch(`/reviewers/${created.body.id}`).send({ name: 'Renamed', role: 'admin' }).expect(200);
      expect(patched.body).toMatchObject({ name: 'Renamed', role: 'admin' });
      await as(cookie).patch('/reviewers/00000000-0000-4000-8000-000000000000').send({ name: 'x' }).expect(404);
      await as(cookie).patch(`/reviewers/${created.body.id}`).send({ passwordHash: 'x' }).expect(400);

      // the new reviewer can sign in with the password the admin set; an admin reset replaces it
      await rawLogin('new@example.com').expect(200);
      await as(cookie).patch(`/reviewers/${created.body.id}`).send({ password: 'a different password' }).expect(200);
      await rawLogin('new@example.com').expect(401);
      await rawLogin('new@example.com', 'a different password').expect(200);

      const list = await as(cookie).get('/reviewers').expect(200);
      expect(list.body).toHaveLength(2);
    });

    it('an admin reset of a password or a demotion ends that reviewer\'s sessions', async () => {
      await addReviewer('admin@example.com', 'admin');
      const bob = await addReviewer('bob@example.com', 'admin');
      const adminCookie = await login('admin@example.com');
      const bobCookie = await login('bob@example.com');
      await as(adminCookie).patch(`/reviewers/${bob.id}`).send({ password: 'a different password' }).expect(200);
      await as(bobCookie).get('/auth/me').expect(401);
      const again = await login('bob@example.com', 'a different password');
      await as(adminCookie).patch(`/reviewers/${bob.id}`).send({ role: 'reviewer' }).expect(200);
      await as(again).get('/auth/me').expect(401);
    });

    it('is forbidden to non-admins, and to key and demo callers (no identity)', async () => {
      await addReviewer('admin@example.com', 'admin');
      const plain = await addReviewer('plain@example.com');
      const cookie = await login('plain@example.com');
      await as(cookie).get('/reviewers').expect(403);
      await as(cookie).post('/reviewers').send({ email: 'x@example.com', name: 'X', role: 'reviewer', password: PW }).expect(403);
      await as(cookie).patch(`/reviewers/${plain.id}`).send({ role: 'admin' }).expect(403);
      await http().get('/reviewers').expect(401);
    });

    it('is forbidden to key and demo callers', async () => {
      await app.close();
      await boot({ REVIEWER_API_KEY: 'rev-key' });
      await http().get('/reviewers').set('Authorization', 'Bearer rev-key').expect(403);
      await app.close();
      delete process.env.REVIEWER_API_KEY;
      await boot();
      await http().get('/reviewers').expect(403);
    });

    it('never deactivates or demotes the last active admin, even with concurrent requests', async () => {
      const a = await addReviewer('a@example.com', 'admin');
      const b = await addReviewer('b@example.com', 'admin');
      const cookie = await login('a@example.com');
      await as(cookie).patch(`/reviewers/${b.id}`).send({ active: false }).expect(200);
      const blocked = await as(cookie).patch(`/reviewers/${a.id}`).send({ active: false }).expect(409);
      expect(blocked.body.code).toBe('LAST_ADMIN');
      await as(cookie).patch(`/reviewers/${a.id}`).send({ role: 'reviewer' }).expect(409);

      // two admins demoting each other at the same instant: exactly one wins
      await as(cookie).patch(`/reviewers/${b.id}`).send({ active: true }).expect(200);
      const bCookie = await login('b@example.com');
      const results = await Promise.all([
        as(cookie).patch(`/reviewers/${b.id}`).send({ active: false }),
        as(bCookie).patch(`/reviewers/${a.id}`).send({ active: false }),
      ]);
      // the loser is 409 (reached the check) or 401 (the winner already ended its session): never a second 200
      const statuses = results.map((r) => r.status).sort();
      expect(statuses[0]).toBe(200);
      expect([401, 409]).toContain(statuses[1]);
      expect(await store.countActiveAdmins()).toBe(1);
    });

    it('leaks no hash, counter or token in any response body', async () => {
      await addReviewer('admin@example.com', 'admin');
      for (let i = 0; i < 2; i++) await rawLogin('admin@example.com', 'wrong password!!').expect(401);
      const cookie = await login('admin@example.com');
      const token = cookie.split('=')[1];
      const bodies = [
        (await as(cookie).get('/auth/me')).text,
        (await as(cookie).get('/reviewers')).text,
        (await as(cookie).post('/reviewers').send({ email: 'n@example.com', name: 'N', role: 'reviewer', password: PW })).text,
        (await as(cookie).patch('/reviewers/00000000-0000-4000-8000-000000000000').send({ name: 'x' })).text,
        (await rawLogin('admin@example.com')).text,
      ];
      for (const text of bodies) {
        expect(text).not.toMatch(/scrypt|password_hash|passwordHash|failed_?attempts|locked|token/i);
        expect(text).not.toContain(token);
      }
    });
  });
});
