import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/http/setup';

// Runs against a real Postgres; skipped unless E2E_DATABASE_URL is set (CI sets it).
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

maybe('HTTP hardening (e2e)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const KEYS = ['CORS_ORIGINS', 'TRUST_PROXY', 'RATE_LIMIT_PER_MINUTE', 'RATE_LIMIT_START_PER_MINUTE', 'RATE_LIMIT_MESSAGES_PER_MINUTE'];

  const boot = async (env: Record<string, string> = {}) => {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    Object.assign(process.env, env);
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    configureApp(app);
    await app.init();
  };

  afterEach(async () => {
    await app?.close();
    for (const k of KEYS) delete process.env[k];
  });

  describe('security headers', () => {
    beforeEach(() => boot());

    it('sets helmet defaults and does not advertise Express', async () => {
      const res = await http().get('/health').expect(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('CORS', () => {
    it('allows no cross-origin browser access unless CORS_ORIGINS is set', async () => {
      await boot();
      const res = await http().get('/health').set('Origin', 'https://evil.example.com').expect(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('allows exactly the listed origins, including preflight with the auth headers', async () => {
      await boot({ CORS_ORIGINS: 'https://app.example.com' });
      const ok = await http().get('/health').set('Origin', 'https://app.example.com').expect(200);
      expect(ok.headers['access-control-allow-origin']).toBe('https://app.example.com');
      const other = await http().get('/health').set('Origin', 'https://evil.example.com').expect(200);
      expect(other.headers['access-control-allow-origin']).toBeUndefined();

      const pre = await http()
        .options('/conversations')
        .set('Origin', 'https://app.example.com')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,authorization,x-conversation-token');
      expect(pre.headers['access-control-allow-origin']).toBe('https://app.example.com');
      expect(pre.headers['access-control-allow-headers'].toLowerCase()).toContain('x-conversation-token');
    });
  });

  describe('rate limiting', () => {
    it('limits starting conversations and sending messages more strictly than the rest', async () => {
      await boot({ RATE_LIMIT_START_PER_MINUTE: '2', RATE_LIMIT_MESSAGES_PER_MINUTE: '3' });
      const start = () => http().post('/conversations').send({ customerId: 1 });
      const first = await start().expect(201);
      await start().expect(201);
      const blocked = await start().expect(429);
      expect(blocked.headers['retry-after']).toBeDefined();

      const id = first.body.id as string;
      const send = (content: string) => http().post(`/conversations/${id}/messages`).send({ content });
      for (const m of ['one', 'two', 'three']) await send(m).expect(201);
      await send('four').expect(429);

      // reads and other routes keep working: only the expensive routes are tight
      await http().get(`/conversations/${id}`).expect(200);
    });

    it('applies a per-client default to everything but never throttles /health', async () => {
      await boot({ RATE_LIMIT_PER_MINUTE: '3' });
      for (let i = 0; i < 3; i++) await http().get('/approvals').expect(200);
      await http().get('/approvals').expect(429);
      for (let i = 0; i < 6; i++) await http().get('/health').expect(200);
    });

    it('keys clients by the forwarded address once TRUST_PROXY is set', async () => {
      await boot({ RATE_LIMIT_PER_MINUTE: '2', TRUST_PROXY: '1' });
      const as = (ip: string) => http().get('/approvals').set('X-Forwarded-For', ip);
      await as('203.0.113.1').expect(200);
      await as('203.0.113.1').expect(200);
      await as('203.0.113.1').expect(429);
      await as('203.0.113.2').expect(200); // a different client is unaffected
    });

    it('ignores X-Forwarded-For when no proxy is trusted, so clients cannot dodge the limit', async () => {
      await boot({ RATE_LIMIT_PER_MINUTE: '2' });
      const as = (ip: string) => http().get('/approvals').set('X-Forwarded-For', ip);
      await as('203.0.113.1').expect(200);
      await as('203.0.113.2').expect(200);
      await as('203.0.113.3').expect(429);
    });
  });
});
