import { createHmac } from 'node:crypto';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PgAgentStore } from '../src/db/pg-agent.store';
import { seedDatabase } from '../src/db/seed-data';
import { configureApp } from '../src/http/setup';
import { Notifier } from '../src/notify/notifier';
import { webhookChannel } from '../src/notify/webhook.channel';
import { PG_POOL } from '../src/tokens';

// Runs against a real Postgres; skipped unless E2E_DATABASE_URL is set (CI sets it).
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `check` is true, failing at the deadline instead of hanging. */
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
    await sleep(25);
  }
}

interface Hit { headers: http.IncomingHttpHeaders; body: string }

maybe('reviewer notifications (e2e, real Postgres)', () => {
  const apps: INestApplication[] = [];
  const servers: Server[] = [];
  let savedEnv: NodeJS.ProcessEnv;

  /** A local receiver on a free port that records every request and answers with `receiver.status`. */
  const startReceiver = async () => {
    const hits: Hit[] = [];
    const receiver = {
      hits, status: 200, url: '',
    };
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.statusCode = receiver.status;
        res.end('{}');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    receiver.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    return receiver;
  };

  const boot = async () => {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    const app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    configureApp(app);
    apps.push(app);
    await app.init();
    return app;
  };
  const bootAndSeed = async () => {
    const app = await boot();
    await seedDatabase(app.get(PG_POOL));
    return app;
  };

  /** Starts a conversation for customer 1 and parks a refund. */
  const parkRefund = async (app: INestApplication) => {
    const created = await request(app.getHttpServer()).post('/conversations').send({ customerId: 1 }).expect(201);
    const conversationId = created.body.id as string;
    await request(app.getHttpServer()).post(`/conversations/${conversationId}/messages`)
      .send({ content: 'Order #1 arrived damaged, please refund it' }).expect(201);
    return conversationId;
  };

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith('NOTIFY_') || key === 'REVIEWER_CONSOLE_URL') delete process.env[key];
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    })));
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  describe('claiming in the store', () => {
    let store: PgAgentStore;
    let pool: Pool;
    beforeEach(async () => {
      const app = await bootAndSeed();
      store = app.get(PgAgentStore);
      pool = app.get(PG_POOL);
    });

    const park = async (orderId = 1) => {
      const conv = await store.createConversation(1, 't');
      const run = await store.createRun(conv.id);
      return store.createAction({
        runId: run.id, conversationId: conv.id, toolName: 'issue_refund', toolArgs: { orderId, amount: 18.75, reason: 'damaged' },
        toolCallId: 'call_1', reasoning: 'r', policy: { rule: 'over_threshold', detail: { threshold: 10, priorRefunded: 0, amount: 18.75 } },
      });
    };
    const notifiedAt = async (id: string) =>
      (await pool.query('SELECT notified_at FROM actions WHERE id = $1', [id])).rows[0].notified_at as string | null;

    it('hands out the oldest unannounced row first, once each, with the rule from the requested event', async () => {
      const first = await park(1);
      const second = await park(2);

      const [one] = await store.claimUnnotified(1);
      expect(one).toEqual({
        id: first.id, toolName: 'issue_refund', toolArgs: { orderId: 1, amount: 18.75, reason: 'damaged' },
        createdAt: first.createdAt, rule: 'over_threshold',
      });
      expect((await store.claimUnnotified(1)).map((r) => r.id)).toEqual([second.id]);
      expect(await store.claimUnnotified(1)).toEqual([]);
      expect(await notifiedAt(first.id)).not.toBeNull();
    });

    it('never claims an action that was decided first, and gives a null rule when there is no requested event', async () => {
      const decided = await park();
      const pending = await park();
      await store.decideAction(decided.id, 'approved', 'ok');
      await pool.query("DELETE FROM approval_events WHERE action_id = $1 AND kind = 'requested'", [pending.id]);

      const claimed = await store.claimUnnotified(10);
      expect(claimed.map((r) => r.id)).toEqual([pending.id]);
      expect(claimed[0].rule).toBeNull();
      expect(await notifiedAt(decided.id)).toBeNull();
    });

    it('splits pending rows between concurrent claims without overlap', async () => {
      const ids = new Set((await Promise.all(Array.from({ length: 5 }, () => park()))).map((a) => a.id));
      // open the connections up front, otherwise handshakes stagger the claims and hide the race
      await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT pg_sleep(0.05)')));
      const results = await Promise.all([store.claimUnnotified(10), store.claimUnnotified(10)]);
      const got = results.flat().map((r) => r.id);
      expect(got).toHaveLength(5);
      expect(new Set(got)).toEqual(ids);
    });

    it('does not tell live viewers anything when it claims', async () => {
      await park();
      const seen: string[] = [];
      const listener = await pool.connect();
      await listener.query('LISTEN agent_events');
      listener.on('notification', (n) => seen.push(n.payload ?? ''));
      await store.claimUnnotified(10);
      await sleep(150);
      listener.release();
      expect(seen).toEqual([]);
    });

    it('releaseClaims makes a claimed row claimable again and leaves a decided row alone', async () => {
      const kept = await park();
      const decided = await park();
      expect((await store.claimUnnotified(10)).map((r) => r.id).sort()).toEqual([kept.id, decided.id].sort());
      await store.decideAction(decided.id, 'rejected', 'no');

      await store.releaseClaims([]); // nothing to do
      await store.releaseClaims([kept.id, decided.id]);

      expect(await notifiedAt(kept.id)).toBeNull();
      expect(await notifiedAt(decided.id)).not.toBeNull();
      expect((await store.claimUnnotified(10)).map((r) => r.id)).toEqual([kept.id]);
    });
  });

  describe('end to end', () => {
    it('sends one signed, PII-free webhook per parked approval and nothing when it is decided', async () => {
      const receiver = await startReceiver();
      process.env.NOTIFY_WEBHOOK_URL = receiver.url;
      process.env.NOTIFY_WEBHOOK_SECRET = 'e2e-secret';
      process.env.REVIEWER_CONSOLE_URL = 'http://localhost:3000/reviewer';
      const app = await bootAndSeed();
      const conversationId = await parkRefund(app);

      await until(() => receiver.hits.length >= 1);
      const [hit] = receiver.hits;
      const payload = JSON.parse(hit.body);
      expect(payload.event).toBe('approval.requested');
      const keys = Object.keys(payload.approval);
      expect(['id', 'tool', 'orderId', 'amount', 'rule', 'createdAt', 'consoleUrl']).toEqual(expect.arrayContaining(keys));
      expect(keys).toEqual(expect.arrayContaining(['id', 'tool', 'orderId', 'rule']));
      expect(payload.approval).toMatchObject({ tool: 'issue_refund', orderId: 1, consoleUrl: expect.stringContaining('http://localhost:3000/reviewer') });
      for (const leaked of ['Ava', 'ava.brooks@example.com', 'damaged', conversationId]) expect(hit.body).not.toContain(leaked);

      const timestamp = hit.headers['x-timestamp'] as string;
      const expected = `sha256=${createHmac('sha256', 'e2e-secret').update(`${timestamp}.${hit.body}`).digest('hex')}`;
      expect(hit.headers['x-signature']).toBe(expected);

      await sleep(400);
      expect(receiver.hits).toHaveLength(1);

      await request(app.getHttpServer()).post(`/approvals/${payload.approval.id}`).send({ decision: 'approve' }).expect(201);
      await sleep(500); // longer than the debounce, so a wrongful pass would have fired
      expect(receiver.hits).toHaveLength(1);
    });

    it('announces an approval once even with two replicas listening', async () => {
      const receiver = await startReceiver();
      process.env.NOTIFY_WEBHOOK_URL = receiver.url;
      const first = await bootAndSeed();
      await boot();

      await parkRefund(first);
      await until(() => receiver.hits.length >= 1);
      await sleep(800);
      expect(receiver.hits).toHaveLength(1);
    });

    it('retries three times against the real store, logs one safe line and never repeats the claim', async () => {
      const receiver = await startReceiver();
      receiver.status = 500;
      const app = await bootAndSeed(); // no notify env: the app itself announces nothing
      const logs: string[] = [];
      const notifier = new Notifier({
        store: app.get(PgAgentStore),
        channels: [webhookChannel({ url: receiver.url, secret: 'e2e-secret' })],
        consoleUrl: 'http://localhost:3000/reviewer',
        log: { warn: (m) => logs.push(m) },
        sleep: async () => {},
      });
      await parkRefund(app);

      expect(await notifier.runOnce()).toBe(1);
      expect(receiver.hits).toHaveLength(3);
      const failures = logs.filter((l) => l.includes('failed for approval'));
      expect(failures).toHaveLength(1);
      expect(logs.join('\n')).not.toContain(receiver.url);
      expect(logs.join('\n')).not.toMatch(/127\.0\.0\.1|e2e-secret/);
      expect(await notifier.runOnce()).toBe(0);
      expect(receiver.hits).toHaveLength(3);
    });

    it('is off by default: with nothing configured nothing is claimed', async () => {
      const receiver = await startReceiver();
      const app = await bootAndSeed();
      await parkRefund(app);
      await sleep(500);
      const { rows } = await app.get<Pool>(PG_POOL).query("SELECT notified_at FROM actions WHERE status = 'pending_approval'");
      expect(rows).toEqual([{ notified_at: null }]);
      expect(receiver.hits).toHaveLength(0);
    });
  });
});
