import { type INestApplication, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/http/setup';
import { StructuredLogger } from '../src/logging/structured-logger';
import { seedDatabase } from '../src/db/seed-data';
import { createPool } from '../src/db/pool';

// Runs against a real Postgres; skipped unless E2E_DATABASE_URL is set (CI sets it).
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

maybe('request ids, access log and health (e2e)', () => {
  let app: INestApplication;
  let lines: string[];
  const http = () => request(app.getHttpServer());
  const records = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    const pool = createPool(process.env.E2E_DATABASE_URL!);
    await seedDatabase(pool);
    await pool.end();
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    configureApp(app);
    // A stand-in for application code that logs after an async hop while serving a request.
    app.use('/probe', (_req: Request, res: Response) => {
      setTimeout(() => {
        new Logger('Probe').log('probe');
        res.json({ ok: true });
      }, 5);
    });
    await app.init();
  });

  beforeEach(() => {
    lines = [];
    app.useLogger(new StructuredLogger('json', { out: (l) => lines.push(l), err: (l) => lines.push(l) }));
  });

  afterAll(async () => {
    await app?.close();
  });

  it('gives every response an id, and keeps a well-formed one from the caller', async () => {
    const generated = await http().get('/customers').expect(200);
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const kept = await http().get('/customers').set('X-Request-Id', 'trace-1234abcd').expect(200);
    expect(kept.headers['x-request-id']).toBe('trace-1234abcd');
    const replaced = await http().get('/customers').set('X-Request-Id', 'bad id with spaces').expect(200);
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('writes one access line per request, with the id and the path, and no query string or credentials', async () => {
    await http()
      .get('/approvals?status=pending')
      .set('X-Request-Id', 'trace-aaaa1111')
      .set('Authorization', 'Bearer HEADERSECRET')
      .set('Cookie', 'reviewer_session=COOKIESECRET')
      .expect(200);
    const access = records().filter((r) => r.msg === 'request');
    expect(access).toEqual([
      expect.objectContaining({
        level: 'log',
        context: 'Http',
        requestId: 'trace-aaaa1111',
        method: 'GET',
        path: '/approvals',
        status: 200,
      }),
    ]);
    const all = lines.join('\n');
    for (const secret of ['status=pending', 'HEADERSECRET', 'COOKIESECRET']) expect(all).not.toContain(secret);
  });

  it('logs a rejected request too, still without the query string', async () => {
    const res = await http().get('/approvals?token=QUERYSECRET').expect(400);
    const access = records().find((r) => r.msg === 'request');
    expect(access).toMatchObject({ path: '/approvals', status: 400, requestId: res.headers['x-request-id'] });
    expect(lines.join('\n')).not.toContain('QUERYSECRET');
  });

  it('carries the request id into logs written later in the same request', async () => {
    const res = await http().get('/probe').expect(200);
    const probe = records().find((r) => r.msg === 'probe');
    expect(probe?.requestId).toBe(res.headers['x-request-id']);
  });

  it('does not log health probes', async () => {
    await http().get('/health').expect(200);
    await http().get('/health/live').expect(200);
    await http().get('/health/ready').expect(200);
    expect(records().filter((r) => r.msg === 'request')).toEqual([]);
  });

  it('answers /health/live and /health/ready, and keeps /health as it was', async () => {
    expect((await http().get('/health/live').expect(200)).body).toEqual({ status: 'ok' });
    expect((await http().get('/health/ready').expect(200)).body).toEqual({ status: 'ok', db: 'up' });
    expect((await http().get('/health').expect(200)).body).toMatchObject({
      status: 'ok',
      db: 'up',
      provider: 'mock',
      reviewerAuth: false,
      reviewerAccounts: false,
      customerLogin: false,
    });
  });
});
