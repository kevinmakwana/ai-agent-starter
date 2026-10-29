import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { seedDatabase } from '../src/db/seed-data';
import { configureApp } from '../src/http/setup';
import { PG_POOL } from '../src/tokens';

// Runs against a real Postgres; skipped unless E2E_DATABASE_URL is set (CI sets it).
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

interface SseEvent { event: string; data: any }

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${ms}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const REFUND = 'Order #1 arrived damaged, please refund it';
const reviewer = { Authorization: 'Bearer rev-key' };

maybe('SSE streams (e2e, real Postgres)', () => {
  const saved = {
    REVIEWER_API_KEY: process.env.REVIEWER_API_KEY,
    STREAM_MAX_PER_CONVERSATION: process.env.STREAM_MAX_PER_CONVERSATION,
  };
  let app: INestApplication;
  let pool: Pool;
  let base: string;
  let appClosed = false; // a test that closes the app itself sets this so afterEach does not close it twice
  let open: Array<{ close: () => Promise<void> }> = [];

  /** Opens a stream with fetch (supertest cannot read one) and records the typed events it carries. */
  const openSse = async (path: string, headers: Record<string, string> = {}) => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}${path}`, { headers, signal: ctrl.signal });
    const events: SseEvent[] = [];
    let reading: Promise<void> = Promise.resolve();
    let endedByServer = false;
    if (res.ok) {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      reading = (async () => {
        let buffer = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) { endedByServer = true; return; }
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop()!;
            for (const block of blocks) {
              const lines = block.split('\n');
              const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
              if (!event) continue; // comment-only block (`: connected`, `: ping`)
              const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
              events.push({ event, data: JSON.parse(data) });
            }
          }
        } catch {
          // aborted by close()
        }
      })();
    }
    const stream = {
      res,
      events,
      get endedByServer() { return endedByServer; },
      close: async () => {
        ctrl.abort();
        await reading;
      },
    };
    open.push(stream);
    return stream;
  };

  /** A request that is expected to be refused: returns the status and drops the body (it would never end if a stream opened). */
  const refused = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { headers });
    const contentType = res.headers.get('content-type') ?? '';
    await res.body?.cancel();
    return { status: res.status, contentType };
  };

  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const newConversation = async (customerId = 1) => {
    const res = await post('/conversations', { customerId });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; accessToken: string };
    return { id: body.id, token: { 'x-conversation-token': body.accessToken } };
  };

  const send = (c: { id: string; token: Record<string, string> }, content: string) =>
    post(`/conversations/${c.id}/messages`, { content }, c.token);

  const has = (events: SseEvent[], event: string, conversationId: string) =>
    events.some((e) => e.event === event && e.data.conversationId === conversationId);

  /** Waits until nothing has arrived for a moment, so a later `clear` cannot race a straggler. */
  const settle = async (events: SseEvent[], quietMs = 250) => {
    let seen = -1;
    while (seen !== events.length) {
      seen = events.length;
      await new Promise((r) => setTimeout(r, quietMs));
    }
  };

  beforeEach(async () => {
    appClosed = false;
    process.env.REVIEWER_API_KEY = 'rev-key';
    process.env.STREAM_MAX_PER_CONVERSATION = '2';
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    configureApp(app);
    await app.init();
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    pool = app.get(PG_POOL);
    await seedDatabase(pool);
  });

  afterEach(async () => {
    // an open SSE connection would keep the server from closing
    const streams = open;
    open = [];
    await Promise.all(streams.map((s) => s.close()));
    if (!appClosed) await app?.close();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('a customer stream receives trace for its own conversation', async () => {
    const c = await newConversation();
    const stream = await openSse(`/conversations/${c.id}/events`, c.token);
    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get('content-type')).toMatch(/^text\/event-stream/);

    expect((await send(c, 'hello')).status).toBe(201);

    await waitFor(() => has(stream.events, 'trace', c.id));
    expect(stream.events.find((e) => e.event === 'trace')!.data).toEqual({ conversationId: c.id });
  });

  it("a stream never carries another conversation's events", async () => {
    const a = await newConversation(1);
    const b = await newConversation(2);
    const streamA = await openSse(`/conversations/${a.id}/events`, a.token);
    const watcher = await openSse('/events', reviewer); // proves the other conversation's events really were produced

    expect((await send(b, 'hello from b')).status).toBe(201);
    await waitFor(() => has(watcher.events, 'trace', b.id));
    expect((await send(a, 'hello from a')).status).toBe(201);
    await waitFor(() => has(streamA.events, 'trace', a.id));
    await settle(streamA.events);

    expect(has(watcher.events, 'trace', b.id)).toBe(true);
    expect(streamA.events.length).toBeGreaterThan(0);
    for (const e of streamA.events) expect(e).toEqual({ event: 'trace', data: { conversationId: a.id } });
  });

  it('a customer stream never carries approvals or audit', async () => {
    const c = await newConversation();
    const customer = await openSse(`/conversations/${c.id}/events`, c.token);
    const watcher = await openSse('/events', reviewer);

    const res = await send(c, REFUND);
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).run.status).toBe('awaiting_approval');

    await waitFor(() => has(watcher.events, 'approvals', c.id) && has(watcher.events, 'audit', c.id));
    await waitFor(() => has(customer.events, 'trace', c.id)); // the customer stream was live, just filtered
    await settle(customer.events);

    const names = new Set(customer.events.map((e) => e.event));
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) expect(['trace', 'resync']).toContain(name);
    expect(names.has('approvals')).toBe(false);
    expect(names.has('audit')).toBe(false);
  });

  it('the reviewer stream sees approvals and audit when a refund is parked and decided', async () => {
    const c = await newConversation();
    const stream = await openSse('/events', reviewer);
    expect(stream.res.status).toBe(200);

    expect((await send(c, REFUND)).status).toBe(201);
    await waitFor(() => has(stream.events, 'approvals', c.id) && has(stream.events, 'audit', c.id));
    await settle(stream.events);
    stream.events.length = 0;

    const list = await fetch(`${base}/approvals?status=pending`, { headers: reviewer });
    expect(list.status).toBe(200);
    const [approval] = (await list.json()) as Array<{ id: string; conversationId: string }>;
    expect(approval.conversationId).toBe(c.id);
    expect((await post(`/approvals/${approval.id}`, { decision: 'approve' }, reviewer)).status).toBe(201);

    await waitFor(() => has(stream.events, 'approvals', c.id) && has(stream.events, 'audit', c.id));
  });

  it('refuses unauthorised streams and malformed ids', async () => {
    const mine = await newConversation(1);
    const other = await newConversation(2);
    const path = `/conversations/${mine.id}/events`;

    for (const [headers, label] of [
      [{}, 'no token'],
      [{ 'x-conversation-token': 'wrong' }, 'wrong token'],
      [other.token, "another conversation's token"],
    ] as const) {
      const r = await refused(path, headers);
      expect({ label, status: r.status }).toEqual({ label, status: 401 });
      expect(r.contentType).not.toMatch(/event-stream/);
    }
    expect((await refused('/events')).status).toBe(401);
    expect((await refused('/events', { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await refused('/events', mine.token)).status).toBe(401); // a customer token is not a reviewer key

    const asReviewer = await openSse(path, reviewer);
    expect(asReviewer.res.status).toBe(200);
    const asOwner = await openSse(path, mine.token);
    expect(asOwner.res.status).toBe(200);

    expect((await refused('/conversations/not-a-uuid/events', reviewer)).status).toBe(400);
  });

  it('answers 429 over the cap, and closing a stream frees the slot', async () => {
    const c = await newConversation();
    const path = `/conversations/${c.id}/events`;
    const first = await openSse(path, c.token);
    const second = await openSse(path, c.token);
    expect([first.res.status, second.res.status]).toEqual([200, 200]);

    expect((await refused(path, c.token)).status).toBe(429);

    await first.close();
    // the server notices the disconnect asynchronously, so poll (up to 2s) until a new open is accepted
    const deadline = Date.now() + 2000;
    let status = 0;
    while (status !== 200) {
      if (Date.now() > deadline) throw new Error('the slot was not freed within 2s');
      const attempt = await openSse(path, c.token);
      status = attempt.res.status;
      if (status !== 200) {
        expect(status).toBe(429);
        await attempt.res.body?.cancel();
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    // the new stream took the freed slot, so the cap of two is full again
    expect((await refused(path, c.token)).status).toBe(429);
  });

  it('a killed LISTEN connection yields resync and the stream keeps working', async () => {
    const c = await newConversation();
    const stream = await openSse('/events', reviewer);
    expect(stream.res.status).toBe(200);

    const killed = await pool.query(
      `SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name = 'agent-events-listener'`,
    );
    expect(killed.rows.length).toBeGreaterThanOrEqual(1);
    expect(killed.rows.every((r) => r.ok === true)).toBe(true);

    await waitFor(() => stream.events.some((e) => e.event === 'resync'), 5000);
    expect(stream.events.find((e) => e.event === 'resync')!.data).toEqual({});

    expect((await send(c, 'hello after the reconnect')).status).toBe(201);
    await waitFor(() => has(stream.events, 'trace', c.id));
  });

  it('treats the conversation id case-insensitively: one cap budget, and the stream still gets its events', async () => {
    const c = await newConversation();
    const lower = `/conversations/${c.id}/events`;
    const upper = `/conversations/${c.id.toUpperCase()}/events`;
    const first = await openSse(lower, c.token);
    const second = await openSse(lower, c.token);
    expect([first.res.status, second.res.status]).toEqual([200, 200]);
    expect((await refused(upper, c.token)).status).toBe(429);

    await first.close();
    const deadline = Date.now() + 2000;
    let shouting = await openSse(upper, c.token);
    while (shouting.res.status !== 200) {
      if (Date.now() > deadline) throw new Error('the slot was not freed within 2s');
      expect(shouting.res.status).toBe(429);
      await shouting.res.body?.cancel();
      await new Promise((r) => setTimeout(r, 50));
      shouting = await openSse(upper, c.token);
    }
    expect((await send(c, 'hello')).status).toBe(201);
    await waitFor(() => has(shouting.events, 'trace', c.id));
  });

  it('a rolled-back write publishes nothing; a committed one does', async () => {
    const c = await newConversation();
    const ghost = await newConversation(2);
    const stream = await openSse('/events', reviewer);
    expect(stream.res.status).toBe(200);
    await settle(stream.events); // let the creation notifications (if any) pass before counting
    stream.events.length = 0;

    const payload = (id: string) => JSON.stringify({ kind: 'trace', conversationId: id });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_notify($1, $2)', ['agent_events', payload(ghost.id)]);
      await client.query('ROLLBACK');
      // a committed notify is delivered (positive proof the stream is live) ...
      await client.query('SELECT pg_notify($1, $2)', ['agent_events', payload(c.id)]);
    } finally {
      client.release();
    }
    await waitFor(() => has(stream.events, 'trace', c.id));
    await settle(stream.events);
    // ... and the rolled-back one never was
    expect(has(stream.events, 'trace', ghost.id)).toBe(false);
    expect(stream.events).toEqual([{ event: 'trace', data: { conversationId: c.id } }]);

    // a real committed write still arrives afterwards
    expect((await send(ghost, 'hello')).status).toBe(201);
    await waitFor(() => has(stream.events, 'trace', ghost.id));
  });

  it('a message POST still blocks until the run is done while a stream is open', async () => {
    const c = await newConversation();
    const stream = await openSse(`/conversations/${c.id}/events`, c.token);

    const res = await send(c, 'hello');
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.run.status).toBe('completed');
    expect(body.run.steps.at(-1)).toMatchObject({ role: 'assistant' });

    await waitFor(() => has(stream.events, 'trace', c.id));
  });

  it('app.close() ends open streams and resolves promptly instead of waiting for clients to leave', async () => {
    const c = await newConversation();
    // `connection: close` keeps fetch's pooled keep-alive sockets (kept ~4s by undici) out of the timing: the
    // only thing that can hold the server open here is a stream that never ends.
    const customer = await openSse(`/conversations/${c.id}/events`, { ...c.token, connection: 'close' });
    const watcher = await openSse('/events', { ...reviewer, connection: 'close' });
    expect([customer.res.status, watcher.res.status]).toEqual([200, 200]);
    // the stream is flowing, not just opened
    expect((await send(c, 'hello')).status).toBe(201);
    await waitFor(() => has(customer.events, 'trace', c.id));

    // Both streams are deliberately left open: nothing but the shutdown itself can end them.
    const started = Date.now();
    appClosed = true;
    await app.close();
    expect(Date.now() - started).toBeLessThan(2000);

    // the clients saw the server end the responses (a clean end of stream, not an abort from this side)
    await waitFor(() => customer.endedByServer && watcher.endedByServer, 1000);
  });
});
