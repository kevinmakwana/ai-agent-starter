import { EventEmitter } from 'node:events';
import { StreamBus, type ListenConnection } from './stream-bus';
import type { AgentEvent } from './agent-events';

class FakeConn extends EventEmitter implements ListenConnection {
  queries: string[] = [];
  ended = false;
  /** How `SELECT 1` behaves: answers, fails, or never answers (a silently dead socket). */
  probe: 'ok' | 'fail' | 'hang' = 'ok';
  constructor(private readonly failConnect?: Error) { super(); }
  async connect() { if (this.failConnect) throw this.failConnect; }
  async query(sql: string) {
    this.queries.push(sql);
    if (sql === 'SELECT 1' && this.probe === 'fail') throw new Error('connection terminated');
    if (sql === 'SELECT 1' && this.probe === 'hang') await new Promise(() => undefined);
  }
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

function makeBus(conns: FakeConn[], heartbeat?: { intervalMs: number; timeoutMs: number }) {
  const errors: unknown[] = [];
  let i = 0;
  const bus = new StreamBus({ connect: () => conns[Math.min(i++, conns.length - 1)], retryMs: { min: 1, max: 5 }, heartbeat, onError: (e) => errors.push(e) });
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
  describe('listener heartbeat', () => {
    const heartbeat = { intervalMs: 10, timeoutMs: 20 };
    const probes = (c: FakeConn) => c.queries.filter((q) => q === 'SELECT 1').length;

    it('probes a healthy connection repeatedly and emits nothing', async () => {
      const conn = new FakeConn();
      const { bus, errors, opened } = makeBus([conn, new FakeConn()], heartbeat);
      const seen: AgentEvent[] = [];
      bus.subscribe((e) => seen.push(e));
      await bus.onModuleInit();
      await until(() => probes(conn) >= 3);
      expect(seen).toEqual([]);
      expect(errors).toEqual([]);
      expect(opened()).toBe(1);
      await bus.onApplicationShutdown();
    });

    it('treats a failed probe as a lost connection: reconnects and emits exactly one resync', async () => {
      const first = new FakeConn();
      const second = new FakeConn();
      const { bus, errors } = makeBus([first, second], heartbeat);
      const seen: AgentEvent[] = [];
      bus.subscribe((e) => seen.push(e));
      await bus.onModuleInit();
      first.probe = 'fail';

      await until(() => seen.length > 0);
      expect(seen).toEqual([{ kind: 'resync' }]);
      expect(first.ended).toBe(true);
      expect(second.queries[0]).toBe('LISTEN agent_events');
      expect(errors).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 60));
      expect(seen).toEqual([{ kind: 'resync' }]);
      await bus.onApplicationShutdown();
    });

    it('treats a probe that never answers as a lost connection', async () => {
      const first = new FakeConn();
      const second = new FakeConn();
      const { bus, errors } = makeBus([first, second], heartbeat);
      const seen: AgentEvent[] = [];
      bus.subscribe((e) => seen.push(e));
      await bus.onModuleInit();
      first.probe = 'hang';

      await until(() => seen.length > 0);
      expect(seen).toEqual([{ kind: 'resync' }]);
      expect(first.ended).toBe(true);
      expect(String((errors[0] as Error).message)).toMatch(/timed out/);
      await bus.onApplicationShutdown();
    });

    it('stops probing after shutdown, even with a probe in flight', async () => {
      const conn = new FakeConn();
      const { bus, errors, opened } = makeBus([conn, new FakeConn()], heartbeat);
      await bus.onModuleInit();
      await until(() => probes(conn) >= 1);
      conn.probe = 'hang';
      await until(() => probes(conn) >= 2); // a probe is now hanging
      bus.beforeApplicationShutdown();
      await bus.onApplicationShutdown();

      const before = probes(conn);
      await new Promise((r) => setTimeout(r, 80)); // longer than the probe timeout and several intervals
      expect(probes(conn)).toBe(before);
      expect(errors).toEqual([]);
      expect(opened()).toBe(1);
    });
  });
});
