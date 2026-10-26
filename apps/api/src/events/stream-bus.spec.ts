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

  it('tells closing listeners before the connection ends, once, and immediately if already closing', async () => {
    const conn = new FakeConn();
    const { bus, errors, opened } = makeBus([conn, new FakeConn()]);
    await bus.onModuleInit();
    const calls: string[] = [];
    bus.onClosing(() => calls.push(`a (connection ended: ${conn.ended})`));
    bus.onClosing(() => { throw new Error('bad closer'); });
    const offC = bus.onClosing(() => calls.push('c'));
    offC();
    bus.onClosing(() => calls.push('d'));

    bus.beforeApplicationShutdown();
    expect(calls).toEqual(['a (connection ended: false)', 'd']);
    expect(errors).toHaveLength(1);
    bus.beforeApplicationShutdown();
    expect(calls).toHaveLength(2);

    bus.onClosing(() => calls.push('late'));
    expect(calls.at(-1)).toBe('late');

    await bus.onApplicationShutdown();
    expect(conn.ended).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(opened()).toBe(1);
  });
});
