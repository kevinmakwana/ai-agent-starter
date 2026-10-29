# Live updates over SSE (4.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chat and reviewer-console polling with server-sent events, falling back to polling only when the stream is down.

**Architecture:** The store publishes tiny signals (`{kind, conversationId}`) with `pg_notify` inside its write transactions, so Postgres delivers them only on commit. A `StreamBus` holds one dedicated `LISTEN` connection and fans events out to open SSE responses (NestJS `@Sse`). The browser reads the stream with a fetch-based client that sends the normal auth headers, refetches the existing GET endpoints on each signal, reconnects with backoff, and polls while the stream is down.

**Tech Stack:** NestJS 11.2 (`@Sse`, rxjs 7), `pg` 8.23 (`Client`, `LISTEN`), Next.js 16 route handler proxy, React 19, Jest (API), `node:test` run through `tsx` (web).

**Spec:** `docs/superpowers/specs/2026-10-24-sse-streaming-design.md`

## Global Constraints

- Events are signals only: `kind` is `trace`, `approvals` or `audit`, plus a synthetic `resync`. The only payload is `{ "conversationId": "<uuid>" }` (`resync` carries `{}`). No event ever carries step, approval or audit content.
- Customers receive only `trace` (for their own conversation) and `resync`. `approvals` and `audit` are reviewer-only (`GET /events`).
- No credential appears in a URL. The browser client sends `x-conversation-token` or `Authorization: Bearer` headers, exactly like every other call. No `EventSource`, no ticket, no query-string secret.
- NOTIFY is issued on the same transaction as the write, before `COMMIT`. A rolled-back write publishes nothing.
- `resync` is emitted by `StreamBus` after every reconnect that follows a loss or failed connect. No replay buffer, no `Last-Event-ID`.
- Wire format: `text/event-stream`; `event: <kind>` + `data: {...}`; `: ping` comment every 15 s; `: connected` comment immediately on open (NestJS defers response headers until the first message, so the server writes one at once). NestJS sets `Cache-Control` and `X-Accel-Buffering: no` itself.
- Stream caps: `STREAM_MAX_PER_CONVERSATION` (default 5) per conversation and `STREAM_MAX_REVIEWER` (default 20) for `/events`; over the cap returns `429`. A closed client frees its slot.
- Web polling fallback intervals: chat 3 s (500 ms while sending), console 2 s, used only while the stream is not `live`.
- `POST /conversations/:id/messages` keeps its blocking contract.
- Web reconnect backoff: 1 s doubling to 15 s, jittered. 401, 403 and 404 stop retrying. No bytes for 45 s (three missed pings) aborts and reconnects.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- E2E tests run ONLY against the localhost:5435 `aiagent_test` database: `E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5435/aiagent_test`. They re-seed that database. Never touch other ports or other projects' containers.
- `next build` prints a SecurityFatalError about a Next.js 16.4.0 advisory on its first run; an immediate retry passes. Do not run `next upgrade`.
- Match surrounding code style: comment density, naming, 2-space indent, single quotes, trailing commas as in the existing files.

## Review Focus

Failure modes the spec implies but no single task owns. Each has a test named in the owning task.

1. A customer stream must never carry another conversation's events, or `approvals` / `audit` kinds (Task 4 unit test, Task 5 e2e).
2. A closed or errored client must release its stream slot, listener and ping timer, or the cap fills up for good (Task 4 unit test, Task 5 e2e).
3. Losing the LISTEN connection (restart, kill, network) must end in a `resync`, and re-LISTEN, never a silent dead stream (Task 3 unit test, Task 5 e2e).
4. A half-open connection that stops delivering bytes must be detected and reconnected, and a 401 must not retry forever (Task 6 tests).
5. A write that rolls back must publish nothing; a database that is down at boot must not crash the API (Task 2 and Task 3 unit tests).

---

### Task 1: Stream caps in config

**Files:**
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/config.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `AppConfig.streams: { perConversation: number; reviewer: number }` (exported interface `StreamLimits`). Used by Task 4.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/config.spec.ts`:

```ts
describe('stream limits config', () => {
  it('defaults to 5 per conversation and 20 for the reviewer, and validates overrides', () => {
    expect(loadConfig({}).streams).toEqual({ perConversation: 5, reviewer: 20 });
    expect(loadConfig({ STREAM_MAX_PER_CONVERSATION: '2', STREAM_MAX_REVIEWER: '3' }).streams).toEqual({ perConversation: 2, reviewer: 3 });
    expect(() => loadConfig({ STREAM_MAX_PER_CONVERSATION: '0' })).toThrow('STREAM_MAX_PER_CONVERSATION');
    expect(() => loadConfig({ STREAM_MAX_REVIEWER: 'many' })).toThrow('STREAM_MAX_REVIEWER');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx jest src/config.spec.ts`
Expected: FAIL (`streams` is undefined).

- [ ] **Step 3: Implement**

In `apps/api/src/config.ts`, add next to `RateLimits`:

```ts
export interface StreamLimits {
  /** Open SSE streams per conversation (a customer may have several tabs). */
  perConversation: number;
  /** Open reviewer-console streams across the API. */
  reviewer: number;
}
```

Add to `AppConfig` after `rateLimit`:

```ts
  /** Caps on concurrent server-sent-event streams; over the cap answers 429. */
  streams: StreamLimits;
```

Add to the object built in `loadConfig`, after `rateLimit`:

```ts
    streams: {
      perConversation: positiveInt(env, 'STREAM_MAX_PER_CONVERSATION', 5),
      reviewer: positiveInt(env, 'STREAM_MAX_REVIEWER', 20),
    },
```

In `.env.example`, after the `REFUND_AUTO_APPROVE_UNDER` line, add:

```
# Caps on concurrent live-update (SSE) streams; over the cap the API answers 429.
STREAM_MAX_PER_CONVERSATION=5
STREAM_MAX_REVIEWER=20
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npx jest src/config.spec.ts && npm run typecheck -w apps/api`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config.ts apps/api/src/config.spec.ts .env.example
git commit -m "Add STREAM_MAX_PER_CONVERSATION and STREAM_MAX_REVIEWER config

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Publish change signals from the store

**Files:**
- Create: `apps/api/src/events/agent-events.ts`
- Create: `apps/api/src/db/pg-agent.store.notify.spec.ts`
- Modify: `apps/api/src/db/pg-agent.store.ts`

**Interfaces:**
- Produces (`apps/api/src/events/agent-events.ts`):
  - `AGENT_EVENTS_CHANNEL = 'agent_events'`
  - `type AgentEventKind = 'trace' | 'approvals' | 'audit'`
  - `type AgentEvent = { kind: AgentEventKind; conversationId: string } | { kind: 'resync' }`
  - `encodeEvent(kind: AgentEventKind, conversationId: string): string`
  - `parseEvent(payload: string | undefined): AgentEvent | null` (returns null for anything malformed, a non-UUID-ish conversationId, or an unknown kind; it never returns `resync`, which only `StreamBus` creates)
- Consumes: nothing from earlier tasks. Used by Tasks 3 and 4.

Behaviour to implement in `PgAgentStore` (every NOTIFY runs on the same connection as the write, before `COMMIT`):

| method | publishes |
|---|---|
| `createRun` | `trace` |
| `updateRun` | `trace` (conversation id comes from the returned row) |
| `addStep` | `trace` |
| `createAction` | `trace`, `approvals`, and `audit` (the audit one is issued by `insertEvent`) |
| `decideAction` | `trace`, `approvals`, and `audit`, only when a row was claimed |
| `reopenAction` | `trace`, `approvals`, only when a row was reopened |
| `setActionResult` | `trace`, `approvals` |
| `addApprovalEvent` | `audit` (via `insertEvent`) |

`insertEvent(db, e)` issues the `audit` NOTIFY itself, so every caller (inside a transaction or not) gets it. Identical NOTIFYs in one transaction are collapsed by Postgres, so overlap is harmless.

To publish without repeating the begin/commit/rollback block, add a private `inTx` helper and move `createRun`, `createAction` and `decideAction` onto it (behaviour-preserving; the existing suite is the safety net). `decideAction` returning `null` inside `inTx` now commits an empty transaction instead of rolling back; that is equivalent.

- [ ] **Step 1: Write the event helpers**

Create `apps/api/src/events/agent-events.ts`:

```ts
/** Postgres channel the store notifies and StreamBus listens on. */
export const AGENT_EVENTS_CHANNEL = 'agent_events';

export type AgentEventKind = 'trace' | 'approvals' | 'audit';

/** `resync` is synthetic: StreamBus emits it after a lost connection, since events may have been missed. */
export type AgentEvent = { kind: AgentEventKind; conversationId: string } | { kind: 'resync' };

const KINDS: readonly string[] = ['trace', 'approvals', 'audit'];

export const encodeEvent = (kind: AgentEventKind, conversationId: string): string =>
  JSON.stringify({ kind, conversationId });

/** Anything malformed (or unknown) is dropped rather than thrown: a bad NOTIFY must never break the listener. */
export function parseEvent(payload: string | undefined): AgentEvent | null {
  if (!payload) return null;
  let raw: unknown;
  try { raw = JSON.parse(payload); } catch { return null; }
  if (typeof raw !== 'object' || raw === null) return null;
  const { kind, conversationId } = raw as { kind?: unknown; conversationId?: unknown };
  if (typeof kind !== 'string' || !KINDS.includes(kind) || typeof conversationId !== 'string' || !conversationId) return null;
  return { kind: kind as AgentEventKind, conversationId };
}
```

- [ ] **Step 2: Write the failing store spec**

Create `apps/api/src/db/pg-agent.store.notify.spec.ts`. It uses a fake `Pool` (no database) that records each statement as a short label, so the order BEGIN → write → NOTIFY → COMMIT is asserted exactly:

```ts
import type { Pool } from 'pg';
import { PgAgentStore } from './pg-agent.store';

const C = 'c1';
const notice = (kind: string) => `NOTIFY ${JSON.stringify({ kind, conversationId: C })}`;

/** Records statements as short labels; `respond` returns rows for a statement, or an Error to make it fail. */
function fakePool(respond: (text: string) => any[] | Error) {
  const calls: string[] = [];
  const run = async (text: string, values?: unknown[]) => {
    const label = /^\s*(BEGIN|COMMIT|ROLLBACK)/.test(text) ? text.trim().split(/\s+/)[0]
      : text.includes('pg_notify') ? `NOTIFY ${values?.[1]}`
      : text.trim().split(/\s+/).slice(0, 3).join(' ');
    calls.push(label);
    const out = respond(text);
    if (out instanceof Error) throw out;
    return { rows: out, rowCount: out.length };
  };
  const pool = { query: run, connect: async () => ({ query: run, release: () => undefined }) } as unknown as Pool;
  return { pool, calls };
}

const stepRow = { id: 1, run_id: 'r1', conversation_id: C, role: 'user' };
const actionRow = { id: 'a1', run_id: 'r1', conversation_id: C, tool_name: 'issue_refund', tool_args: {}, status: 'approved' };
const eventRow = { id: 1, kind: 'approved', conversation_id: C };

describe('PgAgentStore change signals', () => {
  it('addStep publishes trace inside its transaction, before COMMIT', async () => {
    const { pool, calls } = fakePool(() => [stepRow]);
    await new PgAgentStore(pool).addStep({ runId: 'r1', conversationId: C, role: 'user', content: 'hi' });
    expect(calls).toEqual(['BEGIN', 'INSERT INTO steps', notice('trace'), 'COMMIT']);
  });

  it('decideAction publishes trace, approvals and audit before COMMIT', async () => {
    const { pool, calls } = fakePool((t) => (t.includes('UPDATE actions') ? [actionRow] : [eventRow]));
    await new PgAgentStore(pool).decideAction('a1', 'approved', 'ok');
    expect(calls).toEqual([
      'BEGIN', 'UPDATE actions SET', 'INSERT INTO approval_events', notice('audit'), notice('trace'), notice('approvals'), 'COMMIT',
    ]);
  });

  it('decideAction publishes nothing when the action was already decided', async () => {
    const { pool, calls } = fakePool(() => []);
    expect(await new PgAgentStore(pool).decideAction('a1', 'approved')).toBeNull();
    expect(calls.filter((c) => c.startsWith('NOTIFY'))).toEqual([]);
  });

  it('a failed write rolls back and never publishes or commits', async () => {
    const { pool, calls } = fakePool((t) => (t.includes('approval_events') ? new Error('boom') : [actionRow]));
    await expect(new PgAgentStore(pool).decideAction('a1', 'approved')).rejects.toThrow('boom');
    expect(calls).toEqual(['BEGIN', 'UPDATE actions SET', 'INSERT INTO approval_events', 'ROLLBACK']);
  });

  it('reopenAction publishes trace and approvals only when a row was reopened', async () => {
    const reopened = fakePool(() => [{ conversation_id: C }]);
    await new PgAgentStore(reopened.pool).reopenAction('a1');
    expect(reopened.calls).toEqual(['BEGIN', 'UPDATE actions SET', notice('trace'), notice('approvals'), 'COMMIT']);
    const untouched = fakePool(() => []);
    await new PgAgentStore(untouched.pool).reopenAction('a1');
    expect(untouched.calls.filter((c) => c.startsWith('NOTIFY'))).toEqual([]);
  });

  it('setActionResult publishes trace and approvals; addApprovalEvent publishes audit', async () => {
    const result = fakePool(() => [{ conversation_id: C }]);
    await new PgAgentStore(result.pool).setActionResult('a1', { ok: true });
    expect(result.calls).toEqual(['BEGIN', 'UPDATE actions SET', notice('trace'), notice('approvals'), 'COMMIT']);
    const audit = fakePool(() => [eventRow]);
    await new PgAgentStore(audit.pool).addApprovalEvent({
      kind: 'auto_approved', runId: 'r1', conversationId: C, actorType: 'policy', toolName: 'issue_refund', toolArgs: {},
    });
    expect(audit.calls).toEqual(['BEGIN', 'INSERT INTO approval_events', notice('audit'), 'COMMIT']);
  });
});
```

(Adjust the exact label strings only if a statement's first three words differ; the point is the order, with every NOTIFY between the write and `COMMIT`. In `decideAction` the audit NOTIFY comes from `insertEvent`, so it precedes the trace/approvals pair; keep that order.)

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && npx jest src/db/pg-agent.store.notify.spec.ts`
Expected: FAIL (no NOTIFY statements are issued).

- [ ] **Step 4: Implement in `pg-agent.store.ts`**

Add imports `import type { PoolClient } from 'pg';` (merge with the existing `Pool` import) and `import { AGENT_EVENTS_CHANNEL, type AgentEventKind, encodeEvent } from '../events/agent-events';`.

Add the helpers inside `PgAgentStore`:

```ts
  /** Runs `work` in one transaction on its own connection. */
  private async inTx<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** Postgres delivers a NOTIFY only when its transaction commits, so a signal never outruns (or outlives) its write. */
  private async publish(db: Db, conversationId: string, ...kinds: AgentEventKind[]): Promise<void> {
    for (const kind of kinds) await db.query('SELECT pg_notify($1, $2)', [AGENT_EVENTS_CHANNEL, encodeEvent(kind, conversationId)]);
  }
```

Then, per the table above:
- `createRun`, `createAction`, `decideAction`: re-express their bodies on `inTx` (keep every query and the advisory lock exactly as is) and add `await this.publish(db, <conversationId>, 'trace')` / `'trace', 'approvals'` right after the write. In `decideAction`, the `!rows[0]` branch becomes `return null` (no publish).
- `updateRun`: wrap in `inTx`; after the UPDATE publish `trace` for `rows[0].conversation_id` (the row is returned by `RETURNING *`).
- `addStep`: wrap in `inTx`; publish `trace` for `s.conversationId`.
- `reopenAction` and `setActionResult`: wrap in `inTx`; add `RETURNING conversation_id` to the UPDATE; publish `trace`, `approvals` only when a row came back.
- `insertEvent`: after the INSERT, `await this.publish(db, e.conversationId, 'audit')`.
- `addApprovalEvent`: `return this.inTx((db) => this.insertEvent(db, e));`

- [ ] **Step 5: Run it to verify it passes, then the whole API suite**

Run: `cd apps/api && npx jest src/db/pg-agent.store.notify.spec.ts && E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5435/aiagent_test npx jest && npm run typecheck -w apps/api`
Expected: all pass (258 existing plus the new ones), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/events/agent-events.ts apps/api/src/db/pg-agent.store.ts apps/api/src/db/pg-agent.store.notify.spec.ts
git commit -m "Publish change signals with pg_notify inside store transactions

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: StreamBus (the LISTEN connection)

**Files:**
- Create: `apps/api/src/events/stream-bus.ts`
- Create: `apps/api/src/events/stream-bus.spec.ts`

**Interfaces:**
- Consumes: `AGENT_EVENTS_CHANNEL`, `AgentEvent`, `parseEvent` from Task 2.
- Produces (`stream-bus.ts`):
  - `interface ListenConnection { connect(): Promise<void>; query(sql: string): Promise<unknown>; end(): Promise<void>; on(event: string, cb: (...args: any[]) => void): unknown }` (a `pg.Client` satisfies it)
  - `pgListenConnection(connectionString: string): ListenConnection`
  - `class StreamBus implements OnModuleInit, OnApplicationShutdown` with `constructor(opts: { connect: () => ListenConnection; retryMs?: { min: number; max: number }; onError?: (e: unknown) => void })`, `subscribe(listener: (e: AgentEvent) => void): () => void` (returns the unsubscribe), `onModuleInit(): Promise<void>`, `onApplicationShutdown(): Promise<void>`.

Rules: a listener that throws never stops delivery to the others. A failed first connect never throws out of `onModuleInit` (it logs through `onError` and retries). After any lost connection or failed connect, the next successful `LISTEN` is followed by exactly one `resync` to all subscribers. Retry delay is `min * 2^attempt` capped at `max` (default 200 ms to 5 s) and resets after a success. After shutdown there are no reconnects.

- [ ] **Step 1: Write the failing spec**

Create `apps/api/src/events/stream-bus.spec.ts`:

```ts
import { EventEmitter } from 'node:events';
import { StreamBus, type ListenConnection } from './stream-bus';
import type { AgentEvent } from './agent-events';

class FakeConn extends EventEmitter implements ListenConnection {
  queries: string[] = [];
  ended = false;
  constructor(private readonly failConnect?: Error) { super(); }
  async connect() { if (this.failConnect) throw this.failConnect; }
  async query(sql: string) { this.queries.push(sql); }
  async end() { if (!this.ended) { this.ended = true; this.emit('end'); } }
  notify(payload: string) { this.emit('notification', { channel: 'agent_events', payload }); }
}

const until = async (cond: () => boolean, ms = 1000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function makeBus(conns: FakeConn[]) {
  const errors: unknown[] = [];
  let i = 0;
  const bus = new StreamBus({ connect: () => conns[Math.min(i++, conns.length - 1)], retryMs: { min: 1, max: 5 }, onError: (e) => errors.push(e) });
  return { bus, errors, opened: () => i };
}

describe('StreamBus', () => {
  it('LISTENs on agent_events and fans parsed events out to every subscriber', async () => {
    const conn = new FakeConn();
    const { bus } = makeBus([conn]);
    const a: AgentEvent[] = [];
    const b: AgentEvent[] = [];
    bus.subscribe((e) => a.push(e));
    const offB = bus.subscribe((e) => b.push(e));
    await bus.onModuleInit();
    expect(conn.queries).toEqual(['LISTEN agent_events']);

    conn.notify(JSON.stringify({ kind: 'trace', conversationId: 'c1' }));
    conn.notify('not json');
    conn.notify(JSON.stringify({ kind: 'bogus', conversationId: 'c1' }));
    conn.notify(JSON.stringify({ kind: 'resync' }));
    expect(a).toEqual([{ kind: 'trace', conversationId: 'c1' }]);
    expect(b).toEqual(a);

    offB();
    conn.notify(JSON.stringify({ kind: 'audit', conversationId: 'c2' }));
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
    await bus.onApplicationShutdown();
  });

  it('keeps delivering when one listener throws', async () => {
    const conn = new FakeConn();
    const { bus } = makeBus([conn]);
    const seen: AgentEvent[] = [];
    bus.subscribe(() => { throw new Error('bad listener'); });
    bus.subscribe((e) => seen.push(e));
    await bus.onModuleInit();
    conn.notify(JSON.stringify({ kind: 'trace', conversationId: 'c1' }));
    expect(seen).toHaveLength(1);
    await bus.onApplicationShutdown();
  });

  it('reconnects after an error, re-LISTENs and emits exactly one resync', async () => {
    const first = new FakeConn();
    const second = new FakeConn();
    const { bus, errors } = makeBus([first, second]);
    const seen: AgentEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    await bus.onModuleInit();

    first.emit('error', new Error('connection reset'));
    await until(() => seen.length > 0);
    expect(seen).toEqual([{ kind: 'resync' }]);
    expect(second.queries).toEqual(['LISTEN agent_events']);
    expect(errors).toHaveLength(1);

    second.notify(JSON.stringify({ kind: 'trace', conversationId: 'c1' }));
    expect(seen).toHaveLength(2);
    await bus.onApplicationShutdown();
  });

  it('does not throw when the first connect fails: it retries, then emits resync', async () => {
    const down = new FakeConn(new Error('db down'));
    const up = new FakeConn();
    const { bus, errors } = makeBus([down, up]);
    const seen: AgentEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    await expect(bus.onModuleInit()).resolves.toBeUndefined();
    await until(() => up.queries.length === 1);
    await until(() => seen.length === 1);
    expect(seen).toEqual([{ kind: 'resync' }]);
    expect(errors).toHaveLength(1);
    await bus.onApplicationShutdown();
  });

  it('stops cleanly: ends the connection and never reconnects', async () => {
    const conn = new FakeConn();
    const { bus, opened } = makeBus([conn, new FakeConn()]);
    await bus.onModuleInit();
    await bus.onApplicationShutdown();
    expect(conn.ended).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(opened()).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx jest src/events/stream-bus.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `apps/api/src/events/stream-bus.ts`:

```ts
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Client } from 'pg';
import { AGENT_EVENTS_CHANNEL, type AgentEvent, parseEvent } from './agent-events';

/** The slice of pg.Client that StreamBus needs, so tests can substitute a fake. */
export interface ListenConnection {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: string, cb: (...args: any[]) => void): unknown;
}

/** A dedicated connection: a pooled one can be recycled, which would silently drop the LISTEN. */
export const pgListenConnection = (connectionString: string): ListenConnection =>
  new Client({ connectionString, keepAlive: true });

export interface StreamBusOptions {
  /** Returns a fresh, not-yet-connected connection each time. */
  connect: () => ListenConnection;
  /** Reconnect delay doubles from `min` up to `max`. */
  retryMs?: { min: number; max: number };
  onError?: (e: unknown) => void;
}

/**
 * One LISTEN connection fanned out to in-process subscribers. If the connection is lost (or never came up) it
 * reconnects with backoff and, once listening again, tells every subscriber to `resync`: events may have been
 * missed in between, and signals carry no replay.
 */
export class StreamBus implements OnModuleInit, OnApplicationShutdown {
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  private conn: ListenConnection | null = null;
  private timer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stopped = false;
  private degraded = false;

  constructor(private readonly opts: StreamBusOptions) {}

  subscribe(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async onModuleInit(): Promise<void> {
    await this.open();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    const conn = this.conn;
    this.conn = null;
    await conn?.end().catch(() => undefined);
  }

  private emit(event: AgentEvent) {
    for (const listener of this.listeners) {
      try { listener(event); } catch (e) { this.opts.onError?.(e); }
    }
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    const conn = this.opts.connect();
    const lost = () => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.degraded = true;
      this.scheduleRetry();
    };
    // Attached before connecting so an error during connect is never unhandled.
    conn.on('error', (e) => { this.opts.onError?.(e); lost(); conn.end().catch(() => undefined); });
    conn.on('end', lost);
    conn.on('notification', (m: { payload?: string }) => {
      const event = parseEvent(m.payload);
      if (event) this.emit(event);
    });
    try {
      await conn.connect();
      await conn.query(`LISTEN ${AGENT_EVENTS_CHANNEL}`);
    } catch (e) {
      this.opts.onError?.(e);
      this.degraded = true;
      conn.end().catch(() => undefined);
      this.scheduleRetry();
      return;
    }
    if (this.stopped) { conn.end().catch(() => undefined); return; }
    this.conn = conn;
    this.attempt = 0;
    if (this.degraded) {
      this.degraded = false;
      this.emit({ kind: 'resync' });
    }
  }

  private scheduleRetry() {
    if (this.stopped || this.timer) return;
    const { min, max } = this.opts.retryMs ?? { min: 200, max: 5000 };
    const delay = Math.min(max, min * 2 ** this.attempt++);
    this.timer = setTimeout(() => { this.timer = undefined; void this.open(); }, delay);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npx jest src/events/stream-bus.spec.ts && npm run typecheck -w apps/api`
Expected: PASS, typecheck clean. If `new Client(...)` does not satisfy `ListenConnection` structurally, fix the types (not with `any` casts on the whole object).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/events/stream-bus.ts apps/api/src/events/stream-bus.spec.ts
git commit -m "Add StreamBus: one LISTEN connection fanned out to subscribers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The SSE endpoints

**Files:**
- Create: `apps/api/src/events/stream-limiter.ts`
- Create: `apps/api/src/events/event-stream.ts`
- Create: `apps/api/src/events/event-stream.spec.ts`
- Create: `apps/api/src/http/events.controller.ts`
- Modify: `apps/api/src/agent/agent.module.ts`

**Interfaces:**
- Consumes: `StreamBus`, `pgListenConnection` (Task 3); `AgentEvent` (Task 2); `AppConfig.streams` (Task 1); existing `ConversationAccessGuard`, `ReviewerGuard`.
- Produces:
  - `class StreamLimiter { acquire(key: string, max: number): (() => void) | null }` (returns a release function, or null at the cap; releasing twice is harmless)
  - `eventStream(opts: { bus: StreamBus; limiter: StreamLimiter; key: string; max: number; accept: (e: AgentEvent) => boolean; pingMs: number }): Observable<MessageEvent>`
  - routes `GET /conversations/:id/events` and `GET /events`.

Design notes (verified against the installed NestJS 11.2.7 `SseStream`): response headers are deferred until the first message, so the stream emits `{ comment: 'connected' }` the instant it is subscribed. A message with only `comment` is written as `: connected`; messages with `type` and `data` are written as `event: <type>` / `data: <json>` (Nest also adds an incrementing `id:` per connection, which clients ignore). An error before the first message (the 429) still produces a normal HTTP error response. `resync` always passes the `accept` filter.

- [ ] **Step 1: Write the failing spec**

Create `apps/api/src/events/event-stream.spec.ts`:

```ts
import { HttpException } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { AgentEvent } from './agent-events';
import { eventStream } from './event-stream';
import { StreamLimiter } from './stream-limiter';
import type { StreamBus } from './stream-bus';

/** A bus whose subscribers the test can inspect and drive. */
function fakeBus() {
  const listeners = new Set<(e: AgentEvent) => void>();
  const bus = { subscribe: (l: (e: AgentEvent) => void) => { listeners.add(l); return () => { listeners.delete(l); }; } } as unknown as StreamBus;
  return { bus, listeners, emit: (e: AgentEvent) => listeners.forEach((l) => l(e)) };
}

const open = (over: Partial<Parameters<typeof eventStream>[0]> & { bus: StreamBus; limiter: StreamLimiter }) =>
  eventStream({ key: 'k', max: 2, accept: () => true, pingMs: 15_000, ...over });

describe('eventStream', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('commits headers at once with a comment, then forwards accepted events as typed JSON', () => {
    const { bus, emit } = fakeBus();
    const out: MessageEvent[] = [];
    const sub = open({ bus, limiter: new StreamLimiter(), accept: (e) => e.kind === 'trace' && e.conversationId === 'A' }).subscribe((m) => out.push(m));
    expect(out).toEqual([{ comment: 'connected' }]);

    emit({ kind: 'trace', conversationId: 'A' });
    emit({ kind: 'trace', conversationId: 'B' });
    emit({ kind: 'approvals', conversationId: 'A' });
    emit({ kind: 'audit', conversationId: 'A' });
    expect(out.slice(1)).toEqual([{ type: 'trace', data: { conversationId: 'A' } }]);
    sub.unsubscribe();
  });

  it('always passes resync, with an empty payload', () => {
    const { bus, emit } = fakeBus();
    const out: MessageEvent[] = [];
    open({ bus, limiter: new StreamLimiter(), accept: () => false }).subscribe((m) => out.push(m));
    emit({ kind: 'resync' });
    expect(out.at(-1)).toEqual({ type: 'resync', data: {} });
  });

  it('pings on the interval', () => {
    const { bus } = fakeBus();
    const out: MessageEvent[] = [];
    open({ bus, limiter: new StreamLimiter(), pingMs: 1000 }).subscribe((m) => out.push(m));
    jest.advanceTimersByTime(3000);
    expect(out.filter((m) => m.comment === 'ping')).toHaveLength(3);
  });

  it('fails with 429 over the cap, and frees the slot, listener and timer on unsubscribe', () => {
    const { bus, listeners } = fakeBus();
    const limiter = new StreamLimiter();
    const a = open({ bus, limiter, max: 2 }).subscribe();
    const b = open({ bus, limiter, max: 2 }).subscribe();
    expect(listeners.size).toBe(2);

    let error: unknown;
    open({ bus, limiter, max: 2 }).subscribe({ error: (e) => { error = e; } });
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect(listeners.size).toBe(2);

    a.unsubscribe();
    expect(listeners.size).toBe(1);
    expect(jest.getTimerCount()).toBe(1);
    const c = open({ bus, limiter, max: 2 }).subscribe();
    expect(listeners.size).toBe(2);
    b.unsubscribe();
    c.unsubscribe();
    expect(listeners.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('counts caps per key', () => {
    const { bus } = fakeBus();
    const limiter = new StreamLimiter();
    const subs = [open({ bus, limiter, key: 'A', max: 1 }).subscribe(), open({ bus, limiter, key: 'B', max: 1 }).subscribe()];
    let error: unknown;
    open({ bus, limiter, key: 'A', max: 1 }).subscribe({ error: (e) => { error = e; } });
    expect(error).toBeInstanceOf(HttpException);
    subs.forEach((s) => s.unsubscribe());
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx jest src/events/event-stream.spec.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the limiter and the stream**

Create `apps/api/src/events/stream-limiter.ts`:

```ts
/** Counts open streams per key so a client (or a bug) cannot hold an unbounded number of connections. */
export class StreamLimiter {
  private readonly open = new Map<string, number>();

  /** A release function, or null when `key` is already at `max`. Releasing twice is harmless. */
  acquire(key: string, max: number): (() => void) | null {
    const n = this.open.get(key) ?? 0;
    if (n >= max) return null;
    this.open.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(key) ?? 1) - 1;
      if (left <= 0) this.open.delete(key); else this.open.set(key, left);
    };
  }
}
```

Create `apps/api/src/events/event-stream.ts`:

```ts
import { HttpException, HttpStatus, type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { AgentEvent } from './agent-events';
import type { StreamBus } from './stream-bus';
import type { StreamLimiter } from './stream-limiter';

export interface EventStreamOptions {
  bus: StreamBus;
  limiter: StreamLimiter;
  /** What the cap counts: a conversation id, or one shared key for the reviewer stream. */
  key: string;
  max: number;
  /** Which signals this caller may see. `resync` always passes. */
  accept: (e: AgentEvent) => boolean;
  pingMs: number;
}

/**
 * The SSE body. The slot is taken when the response is subscribed (so a request that never gets that far leaks
 * nothing) and given back with the listener and timer when the client goes away.
 */
export function eventStream(o: EventStreamOptions): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    const release = o.limiter.acquire(o.key, o.max);
    if (!release) {
      subscriber.error(new HttpException('Too many open streams; close one and retry.', HttpStatus.TOO_MANY_REQUESTS));
      return undefined;
    }
    // Nest holds the response headers back until the first message, so say something straight away.
    subscriber.next({ comment: 'connected' });
    const unsubscribe = o.bus.subscribe((e) => {
      if (e.kind === 'resync') subscriber.next({ type: 'resync', data: {} });
      else if (o.accept(e)) subscriber.next({ type: e.kind, data: { conversationId: e.conversationId } });
    });
    const ping = setInterval(() => subscriber.next({ comment: 'ping' }), o.pingMs);
    return () => {
      clearInterval(ping);
      unsubscribe();
      release();
    };
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/api && npx jest src/events/event-stream.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add the controller and wire the module**

Create `apps/api/src/http/events.controller.ts`:

```ts
import { Controller, Inject, ParseUUIDPipe, Param, Sse, UseGuards } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { AppConfig } from '../config';
import { eventStream } from '../events/event-stream';
import { StreamBus } from '../events/stream-bus';
import { StreamLimiter } from '../events/stream-limiter';
import { APP_CONFIG } from '../tokens';
import { ConversationAccessGuard } from './conversation-access.guard';
import { ReviewerGuard } from './reviewer.guard';

/** Idle proxies drop quiet connections; a comment this often keeps them open. */
export const STREAM_PING_MS = 15_000;

/**
 * Live-update signals (never content): clients refetch the normal GET endpoints when one arrives, so the
 * customer/reviewer filtering stays in those endpoints. Auth runs in the guards, before any stream opens.
 */
@Controller()
export class EventsController {
  private readonly limiter = new StreamLimiter();

  constructor(private readonly bus: StreamBus, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** A customer (or reviewer) watching one conversation: only that conversation's `trace` changes. */
  @Sse('conversations/:id/events')
  @UseGuards(ConversationAccessGuard)
  conversation(@Param('id', ParseUUIDPipe) id: string): Observable<MessageEvent> {
    return eventStream({
      bus: this.bus, limiter: this.limiter, key: id, max: this.cfg.streams.perConversation, pingMs: STREAM_PING_MS,
      accept: (e) => e.kind === 'trace' && e.conversationId === id,
    });
  }

  /** The reviewer console: every conversation's `trace`, `approvals` and `audit` changes. */
  @Sse('events')
  @UseGuards(ReviewerGuard)
  all(): Observable<MessageEvent> {
    return eventStream({
      bus: this.bus, limiter: this.limiter, key: '*reviewer', max: this.cfg.streams.reviewer, pingMs: STREAM_PING_MS,
      accept: () => true,
    });
  }
}
```

In `apps/api/src/agent/agent.module.ts`: import `Logger` is already there; add imports for `EventsController`, `StreamBus`, `pgListenConnection`; add `EventsController` to `controllers`; add this provider:

```ts
    {
      provide: StreamBus,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) =>
        new StreamBus({
          connect: () => pgListenConnection(cfg.databaseUrl),
          onError: (e) => new Logger('StreamBus').warn(`Live-update listener: ${e instanceof Error ? e.message : e}`),
        }),
    },
```

(Nest runs `onModuleInit` / `onApplicationShutdown` on factory-built providers too.)

- [ ] **Step 6: Run the whole API suite and typecheck**

Run: `cd apps/api && E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5435/aiagent_test npx jest && npm run typecheck -w apps/api`
Expected: all pass, typecheck clean. Check there is no "open handle" or "did not exit" warning from Jest.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/events apps/api/src/http/events.controller.ts apps/api/src/agent/agent.module.ts
git commit -m "Add SSE endpoints for conversation and reviewer live updates

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Stream end-to-end tests

**Files:**
- Create: `apps/api/test/stream.e2e-spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-4. Follow the setup pattern of `apps/api/test/approval-flow.e2e-spec.ts` (env vars, `Test.createTestingModule`, `configureApp(app)`, `seedDatabase`), but start a real listening server with `await app.listen(0)` so `fetch` can read a stream (supertest cannot). Read the port from `(app.getHttpServer().address() as AddressInfo).port` and use `http://127.0.0.1:<port>`.
- Produces: nothing for later tasks.

Test environment for this file: `REVIEWER_API_KEY='rev-key'`, `STREAM_MAX_PER_CONVERSATION='2'`, `LLM_PROVIDER='mock'`, `MOCK_DELAY_MS='0'`, `DATABASE_URL=process.env.E2E_DATABASE_URL`. Set them in `beforeEach` before compiling the module, and restore `REVIEWER_API_KEY` / `STREAM_MAX_PER_CONVERSATION` in `afterAll` (other suites share the process). Skip the whole file unless `E2E_DATABASE_URL` is set, like the other e2e files.

Write a small helper, `openSse(path, headers)`, that does `fetch` with an `AbortController`, reads `res.body` with a reader and `TextDecoder`, splits on blank lines, and pushes `{ event, data }` for blocks that have an `event:` line (comment-only blocks are ignored). It returns `{ res, events, close }`. Keep every opened stream in an array and close them all in `afterEach` BEFORE `app.close()` (an open SSE connection would keep the server from closing). Also write `waitFor(cond, ms = 3000)` that polls every 20 ms and throws on timeout.

Helper to create a conversation: `POST /conversations` with `{ customerId: 1 }` (returns `id` and `accessToken`); send messages with `POST /conversations/:id/messages` and header `x-conversation-token`. The message `'Order #1 arrived damaged, please refund it'` makes the mock provider call `issue_refund`, which parks (the threshold is unset, so every refund waits); the reviewer decides with `POST /approvals/:id` `{ decision: 'approve' }` and `Authorization: Bearer rev-key`; list approvals with `GET /approvals` using the same header.

- [ ] **Step 1: Write the tests (they should fail only if behaviour is missing, so write them against the finished Tasks 1-4)**

Cases, each its own `it`:

1. **A customer stream receives `trace` for its own conversation.** Open the stream with the conversation token; assert `res.status === 200` and the content type starts with `text/event-stream`; send `'hello'`; `waitFor` an event named `trace` whose JSON data is `{ conversationId: <id> }`.
2. **A stream never carries another conversation's events.** Create A and B; open A's stream; send a message in B, then one in A; `waitFor` an event for A; assert every event received has `conversationId === A`.
3. **A customer stream never carries `approvals` or `audit`.** Open the customer stream and the reviewer stream for the same conversation; send the refund message; wait until the reviewer stream has `approvals` and `audit`; assert the customer stream's event names are all in `['trace', 'resync']`.
4. **The reviewer stream sees `approvals` and `audit` when a refund is parked and decided.** Open `/events` with the reviewer key; send the refund message; `waitFor` `approvals` and `audit` events for the conversation; clear the recorded events; approve through the API; `waitFor` `approvals` and `audit` again (the decision).
5. **Auth.** `GET /conversations/:id/events` with no token, with a wrong token, and with a token for a different conversation each return `401` (and no stream); `GET /events` with no key and with a wrong key return `401`; a reviewer key on `/conversations/:id/events` returns `200`; a non-UUID id returns `400`.
6. **Over the cap returns 429; closing a stream frees the slot.** With the cap at 2, open two streams for one conversation, assert a third `fetch` returns `429`, close one stream, then poll (up to 2 s) until a new open returns `200`.
7. **A killed LISTEN connection yields `resync` and the stream keeps working.** Open a reviewer stream; through the app's pool run `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND query = 'LISTEN agent_events'` (it only ever touches the test database's listener sessions); `waitFor` (up to 5 s) a `resync` event; then send a message in a conversation and `waitFor` a `trace` event, proving it re-listened.
8. **A message on a stream-less conversation still works unchanged.** `POST /messages` returns `201` with a completed run while a stream is open (the blocking contract is unchanged), and the stream delivered at least one `trace` before the POST resolved or shortly after.

- [ ] **Step 2: Run**

Run: `cd apps/api && E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5435/aiagent_test npx jest test/stream.e2e-spec.ts`
Expected: PASS. Run it three times in a row to check for flakiness.

- [ ] **Step 3: Run the full suite**

Run: `cd apps/api && E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5435/aiagent_test npx jest && npm run typecheck -w apps/api`
Expected: all pass, no open-handle warnings.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/stream.e2e-spec.ts
git commit -m "Cover the SSE streams end to end

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web stream client and a test runner

**Files:**
- Modify: `apps/web/package.json` (add `"test": "tsx --test \"src/**/*.test.ts\""` and the `tsx` devDependency at the version `apps/api` uses)
- Modify: `package.json` (root `test` script runs both workspaces)
- Modify: `package-lock.json` (via `npm install`)
- Create: `apps/web/src/lib/sse.ts`
- Create: `apps/web/src/lib/sse.test.ts`
- Create: `apps/web/src/lib/stream.ts`
- Create: `apps/web/src/lib/stream.test.ts`

**Interfaces:**
- Produces:
  - `sse.ts`: `interface SseMessage { event: string; data: string }`; `class SseParser { push(chunk: string): SseMessage[] }`. A message with no `event:` field has `event: 'message'`. Multiple `data:` lines join with `\n`. Lines starting with `:` are ignored. Accepts `\n`, `\r\n` and `\r` line ends, including a `\r\n` split across two chunks. A trailing partial line is held until its end arrives. Blank-line dispatch happens only when there is at least one `data:` line.
  - `stream.ts`: `type StreamStatus = 'connecting' | 'live' | 'down'`; `backoffDelay(attempt: number, range: { min: number; max: number }, random?: () => number): number` (`min * 2^attempt` capped at `max`, then scaled by `0.5 + random() / 2`, so between half and the full delay); `openStream(url: string, headers: Record<string, string>, handlers: { onMessage(m: SseMessage): void; onStatus(s: StreamStatus): void; onFatal?(httpStatus: number): void }, options?: { fetchImpl?: typeof fetch; backoff?: { min: number; max: number }; idleMs?: number; random?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> }): () => void` (returns `close`).
- Consumes: nothing from earlier tasks. Library files here use relative imports only (no `@/`), so `tsx` can run the tests without the Next alias.

`openStream` behaviour: starts `connecting`; sets `live` once a response with `ok` arrives; sets `down` on any failure or end and retries after `backoffDelay` (attempt resets to 0 after a successful connect); 401, 403 and 404 call `onFatal(status)`, set `down` and stop; `close()` aborts and stops without further status calls; if no chunk arrives for `idleMs` (default 45 000) the attempt is aborted and retried; messages are parsed with `SseParser` as chunks arrive. Defaults: backoff 1000 to 15000, `fetchImpl` = global `fetch`, `sleep` honours the abort signal.

- [ ] **Step 1: Set up the runner**

Add to `apps/web/package.json` scripts: `"test": "tsx --test \"src/**/*.test.ts\""`, and `tsx` to `devDependencies` (same range as `apps/api`). Change root `package.json` `"test"` to `"npm test -w apps/api && npm test -w apps/web"`. Run `npm install` from the repo root and confirm `package-lock.json` only gains the web workspace's `tsx` link.

- [ ] **Step 2: Write the failing parser tests**

Create `apps/web/src/lib/sse.test.ts` using `node:test` and `node:assert/strict`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SseParser } from './sse';

describe('SseParser', () => {
  it('parses an event with data', () => {
    assert.deepEqual(new SseParser().push('event: trace\ndata: {"a":1}\n\n'), [{ event: 'trace', data: '{"a":1}' }]);
  });
  it('defaults the event name to message', () => {
    assert.deepEqual(new SseParser().push('data: hi\n\n'), [{ event: 'message', data: 'hi' }]);
  });
  it('joins multi-line data with newlines', () => {
    assert.deepEqual(new SseParser().push('data: a\ndata: b\n\n'), [{ event: 'message', data: 'a\nb' }]);
  });
  it('ignores comments and fields it does not use', () => {
    assert.deepEqual(new SseParser().push(': ping\n\nid: 7\nretry: 5\nevent: x\ndata: 1\n\n'), [{ event: 'x', data: '1' }]);
  });
  it('handles chunks split anywhere', () => {
    const p = new SseParser();
    const text = 'event: trace\ndata: {"c":"x"}\n\nevent: resync\ndata: {}\n\n';
    const out = [...text].flatMap((ch) => p.push(ch));
    assert.deepEqual(out, [{ event: 'trace', data: '{"c":"x"}' }, { event: 'resync', data: '{}' }]);
  });
  it('handles CRLF, including a CRLF split across chunks', () => {
    const p = new SseParser();
    assert.deepEqual([...p.push('event: a\r'), ...p.push('\ndata: 1\r\n\r'), ...p.push('\n')], [{ event: 'a', data: '1' }]);
  });
  it('does not dispatch a block with no data line', () => {
    assert.deepEqual(new SseParser().push('event: lonely\n\n'), []);
  });
  it('keeps a trailing partial line until it completes', () => {
    const p = new SseParser();
    assert.deepEqual(p.push('data: par'), []);
    assert.deepEqual(p.push('tial\n\n'), [{ event: 'message', data: 'partial' }]);
  });
  it('strips exactly one leading space from a value', () => {
    assert.deepEqual(new SseParser().push('data:  two\n\n'), [{ event: 'message', data: ' two' }]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails, then implement `sse.ts`**

Run: `cd apps/web && npx tsx --test src/lib/sse.test.ts` → FAIL (module not found). Then create `sse.ts`:

```ts
export interface SseMessage { event: string; data: string }

/** Incremental parser for `text/event-stream`: feed it text chunks, it returns the messages completed so far. */
export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];

  push(chunk: string): SseMessage[] {
    this.buf += chunk;
    // A lone trailing \r might be the first half of \r\n; hold it back until the next chunk.
    const hold = this.buf.endsWith('\r') ? 1 : 0;
    const complete = this.buf.slice(0, this.buf.length - hold);
    const lines = complete.split(/\r\n|\n|\r/);
    this.buf = lines.pop()! + this.buf.slice(this.buf.length - hold);

    const out: SseMessage[] = [];
    for (const line of lines) {
      if (line === '') {
        if (this.data.length) out.push({ event: this.event || 'message', data: this.data.join('\n') });
        this.event = '';
        this.data = [];
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') this.event = value;
        else if (field === 'data') this.data.push(value);
      }
    }
    return out;
  }
}
```

Run again → PASS. (If the `\r` hold-back case misbehaves, fix the parser, not the test.)

- [ ] **Step 4: Write the failing stream tests**

Create `apps/web/src/lib/stream.test.ts`. Build fake responses from a `ReadableStream` the test controls, inject `fetchImpl`, `sleep: async () => undefined` (so retries are instant) and a deterministic `random`. Cases:

1. `backoffDelay`: with `random = () => 1` the delays for attempts 0..6 and range 1000..15000 are `1000, 2000, 4000, 8000, 15000, 15000, 15000`; with `random = () => 0` they are half of those.
2. Status goes `connecting` → `live` on a 200 response and `onMessage` receives parsed messages across chunk boundaries (`event: trace` / `data: {"conversationId":"x"}`).
3. A 401 calls `onFatal(401)`, ends in `down`, and `fetchImpl` was called exactly once (no retry); same for 404.
4. When the server ends the stream, status goes `down` and it reconnects (second `fetchImpl` call), becoming `live` again.
5. A 500 retries (it does not call `onFatal`).
6. `idleMs`: with a stream that never delivers bytes and `idleMs: 20`, the first attempt is aborted and a second `fetchImpl` call happens.
7. `close()` aborts the in-flight request (the fake `fetchImpl` observes `signal.aborted`) and no further status callbacks fire afterwards.
8. The request is made with the given headers (assert the `headers` argument passed to `fetchImpl`).

Run: `cd apps/web && npx tsx --test src/lib/stream.test.ts` → FAIL (module not found).

- [ ] **Step 5: Implement `stream.ts`**

Implement per the interface above. Sketch of the loop (write it carefully; the tests define the behaviour):

```ts
import { SseParser, type SseMessage } from './sse';

export type StreamStatus = 'connecting' | 'live' | 'down';

export function backoffDelay(attempt: number, range: { min: number; max: number }, random: () => number = Math.random): number {
  const base = Math.min(range.max, range.min * 2 ** attempt);
  return base * (0.5 + random() / 2);
}

const FATAL = new Set([401, 403, 404]);
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

export function openStream(url, headers, handlers, options = {}) {
  const { fetchImpl = fetch, backoff = { min: 1000, max: 15000 }, idleMs = 45_000, random = Math.random, sleep = wait } = options;
  const closed = new AbortController();
  const status = (s: StreamStatus) => { if (!closed.signal.aborted) handlers.onStatus(s); };

  void (async () => {
    let attempt = 0;
    status('connecting');
    while (!closed.signal.aborted) {
      const run = new AbortController();
      const stopRun = () => run.abort();
      closed.signal.addEventListener('abort', stopRun, { once: true });
      let idle: ReturnType<typeof setTimeout> | undefined;
      const armIdle = () => { clearTimeout(idle); idle = setTimeout(stopRun, idleMs); };
      try {
        armIdle();
        const res = await fetchImpl(url, { headers, signal: run.signal, cache: 'no-store' });
        if (FATAL.has(res.status)) { status('down'); handlers.onFatal?.(res.status); return; }
        if (res.ok && res.body) {
          attempt = 0;
          status('live');
          const parser = new SseParser();
          const decoder = new TextDecoder();
          const reader = res.body.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            armIdle();
            for (const m of parser.push(decoder.decode(value, { stream: true }))) handlers.onMessage(m);
          }
        }
      } catch {
        /* aborted, network error or a reader failure: fall through to the retry below */
      } finally {
        clearTimeout(idle);
        closed.signal.removeEventListener('abort', stopRun);
      }
      if (closed.signal.aborted) return;
      status('down');
      await sleep(backoffDelay(attempt++, backoff, random), closed.signal);
    }
  })();

  return () => closed.abort();
}
```

Adjust types (`options` parameter type, `fetch` init `cache` is fine in the browser and Node) until `npm run typecheck -w apps/web` is clean. Fix anything the tests expose.

- [ ] **Step 6: Run everything**

Run: `cd apps/web && npm test && cd ../.. && npm run typecheck && npm test` (the last `npm test` needs `E2E_DATABASE_URL` set to the 5435 test database for the API e2e part; the unit parts run regardless).
Expected: web tests pass, typecheck clean for both workspaces.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json apps/web/package.json apps/web/src/lib/sse.ts apps/web/src/lib/sse.test.ts apps/web/src/lib/stream.ts apps/web/src/lib/stream.test.ts
git commit -m "Add a fetch-based SSE client with reconnect and idle detection

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Proxy streaming, the hook and the pages

**Files:**
- Modify: `apps/web/src/app/api/[...path]/route.ts`
- Modify: `apps/web/src/lib/api.ts` (export `authHeaders`)
- Create: `apps/web/src/lib/useEventStream.ts`
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/app/reviewer/page.tsx`
- Modify: `apps/web/src/components/TopBar.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: `openStream`, `StreamStatus` (Task 6); the API routes from Task 4.
- Produces:
  - `api.ts`: `export function authHeaders(auth: Auth): Record<string, string>` (the existing header logic from `call`, reused by `call`).
  - `useEventStream(target: { path: string; auth: Auth } | null, onChange: (changes: StreamChange[]) => void, debounceMs?: number): StreamStatus` with `interface StreamChange { kind: string; conversationId?: string }`.
  - `TopBar` gains an optional `stream?: StreamStatus` prop.

- [ ] **Step 1: Make the proxy stream-safe**

In `route.ts`: add `export const dynamic = 'force-dynamic';`; pass `signal: req.signal` to the upstream `fetch` (closing the browser tab then closes the upstream stream); keep forwarding the same request headers; build the response so that when the upstream `content-type` starts with `text/event-stream` it also sets `cache-control: no-cache, no-transform` and `x-accel-buffering: no`. Non-stream responses stay exactly as they are.

- [ ] **Step 2: Write the hook**

`api.ts`: extract `authHeaders(auth)` (returns `{ authorization: 'Bearer …' }` and/or `{ 'x-conversation-token': … }`) and have `call` use it.

Create `apps/web/src/lib/useEventStream.ts` (`'use client'`):

```ts
'use client';

import { useEffect, useRef, useState } from 'react';
import { authHeaders, type Auth } from './api';
import { openStream, type StreamStatus } from './stream';

export interface StreamChange { kind: string; conversationId?: string }

/**
 * Subscribes to a server-sent-event stream and reports the changes it signals, coalesced over `debounceMs` so a
 * burst of steps causes one refetch. Every (re)connect reports a `resync`: whatever was missed meanwhile is
 * refetched. Returns the connection status; callers poll while it is not `live`.
 */
export function useEventStream(
  target: { path: string; auth: Auth } | null,
  onChange: (changes: StreamChange[]) => void,
  debounceMs = 100,
): StreamStatus {
  const [status, setStatus] = useState<StreamStatus>(target ? 'connecting' : 'down');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const path = target?.path;
  const token = target?.auth.token;
  const key = target?.auth.key;

  useEffect(() => {
    if (!path) { setStatus('down'); return; }
    setStatus('connecting');
    let pending: StreamChange[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const batch = pending;
      pending = [];
      if (batch.length) onChangeRef.current(batch);
    };
    const queue = (change: StreamChange) => {
      pending.push(change);
      if (!timer) timer = setTimeout(flush, debounceMs);
    };
    const close = openStream(`/api${path}`, authHeaders({ token, key }), {
      onStatus: (s) => { setStatus(s); if (s === 'live') queue({ kind: 'resync' }); },
      onMessage: (m) => {
        let conversationId: string | undefined;
        try { conversationId = JSON.parse(m.data)?.conversationId; } catch { /* a bad payload still counts as a change */ }
        queue({ kind: m.event, conversationId });
      },
    });
    return () => { close(); clearTimeout(timer); };
  }, [path, token, key, debounceMs]);

  return status;
}
```

- [ ] **Step 3: Use it in the customer chat**

In `apps/web/src/app/page.tsx`: replace the interval effect with

```ts
  const stream = useEventStream(
    selected ? { path: `/conversations/${selected.id}/events`, auth: { token: selected.token } } : null,
    () => { void refresh(); },
  );

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll only while the live stream is not up; a proxy that buffers SSE then degrades to the old behaviour.
  useEffect(() => {
    if (stream === 'live') return;
    const t = setInterval(refresh, sending ? 500 : 3000);
    return () => clearInterval(t);
  }, [refresh, sending, stream]);
```

and pass `stream={selected ? stream : undefined}` to `TopBar`.

- [ ] **Step 4: Use it in the reviewer console**

In `apps/web/src/app/reviewer/page.tsx`: change `refresh` to `refresh(skipDetail = false)` (when `skipDetail` is true it does not fetch the selected conversation's detail; the list, approvals and, on the audit tab, the audit log are still fetched). Keep a `selectedIdRef` (updated each render) and:

```ts
  const stream = useEventStream(
    locked ? null : { path: '/events', auth: { key } },
    (changes) => {
      const detailAffected = changes.some((c) => c.kind === 'resync' || c.conversationId === selectedIdRef.current);
      void refresh(!detailAffected);
    },
  );

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (stream === 'live') return;
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh, stream]);
```

(The existing 401 handling inside `refresh` stays; a rejected key makes the stream stop retrying with `onFatal` and polling surfaces the sign-in prompt as before.) Pass `stream` to `TopBar`. Keep `decide` calling `await refresh()`.

- [ ] **Step 5: Show the mode in the top bar**

`TopBar`: accept `stream?: StreamStatus`; when provided render, beside the provider chip,

```tsx
{stream && (
  <span className={`chip stream ${stream}`} title={stream === 'live' ? 'Updates arrive instantly' : stream === 'connecting' ? 'Connecting to live updates' : 'Live updates are down; refreshing every few seconds'}>
    <span className="dot" aria-hidden /> {stream === 'live' ? 'Live' : stream === 'connecting' ? 'Connecting' : 'Polling'}
  </span>
)}
```

and add `.chip.stream`, `.chip.stream .dot` (a small filled circle) with green for `live`, amber for `connecting`, and a neutral/red-ish tone for `down`, in `globals.css`, using the file's existing color variables and dark-theme conventions.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test -w apps/web && npm run build -w apps/web` (if the build prints the SecurityFatalError, run it once more). Then, with the API and web dev servers running against the dev database, do the manual check from the Task 8 checklist if you can; otherwise say it was not run.
Expected: typecheck clean, web tests pass, build passes.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "Update the chat and reviewer console over SSE, polling only as a fallback

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Docs, TODO and the final check

**Files:**
- Modify: `README.md`
- Modify: `TODO.md`
- Modify: `docs/superpowers/specs/2026-10-24-sse-streaming-design.md`
- Modify: `docs/superpowers/specs/2026-10-22-approval-policy-audit-log-design.md` (one line)

- [ ] **Step 1: README**

- API table: add rows `GET /conversations/:id/events` (🔑, SSE `trace` signals for one conversation, `429` over `STREAM_MAX_PER_CONVERSATION`) and `GET /events` (🔒, SSE `trace` / `approvals` / `audit` signals for the console, `429` over `STREAM_MAX_REVIEWER`), plus one sentence under the table: events are signals only (`{ "conversationId": "…" }`), clients refetch the normal endpoints, the client sends its credential in headers (no `EventSource`), and every connect is followed by a refetch.
- Configuration table: rows for `STREAM_MAX_PER_CONVERSATION` (default `5`) and `STREAM_MAX_REVIEWER` (default `20`).
- Add a short "Live updates" paragraph (in Architecture or next to the API table): store NOTIFY on commit → one LISTEN connection (`StreamBus`) → SSE; works across API replicas; the UI polls only while the stream is down; a "Live / Connecting / Polling" chip in the top bar.
- Testing section: mention the web unit tests (`npm test` now runs the API and web suites; the web suite uses `node:test` through `tsx`).
- Security notes: streams authenticate with the same headers as the REST API, run the same guards before opening, carry no content, and are capped per conversation / for the reviewer.
- Known limitations: events are hints with no replay; text is not streamed token by token (a model reply appears whole when its step is saved); caps are per process; NOTIFY needs a session-mode Postgres connection (a transaction-pooling proxy such as PgBouncer in transaction mode breaks `LISTEN`).
- "Next steps": remove the "Stream runs to the UI over SSE" bullet (or replace with "stream model tokens as they are generated").

- [ ] **Step 2: TODO and specs**

- `TODO.md`: tick `4.1`.
- In the 4.1 spec, record what the installed NestJS showed: the server writes `: connected` immediately because Nest defers headers until the first message; Nest adds a per-connection `id:` to typed events, which the client ignores (so "no `id:` field" becomes "no replay: ids are per-connection and unused"); `@Sse` with `comment` messages supports the `: ping` heartbeat.
- In the audit-log spec, change the line "It refreshes the way the approvals list does today (SSE arrives with 4.1)." to say it refreshes from the live stream (the polling fallback applies when the stream is down).

- [ ] **Step 3: Full verification**

Run, from the repo root:

```bash
npm run typecheck
E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5435/aiagent_test npm test
npm run build            # if next build prints the SecurityFatalError, run it once more
```

Expected: typecheck clean, API (unit + e2e) and web suites pass, build passes. Report counts. Manual browser check, if a browser and the dev stack are available: open `/` and `/reviewer` in two tabs, send a refund message from the chat and watch the console's Approvals and Audit log update with no refresh and the chip read "Live"; stop the API and watch the chip fall to "Polling", restart it and watch it recover to "Live". If this cannot be run, say so plainly.

- [ ] **Step 4: Commit**

```bash
git add README.md TODO.md docs/superpowers/specs
git commit -m "Document live updates over SSE; tick TODO 4.1

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
