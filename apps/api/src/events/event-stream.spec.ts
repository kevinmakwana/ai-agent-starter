import { HttpException } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { AgentEvent } from './agent-events';
import { eventStream } from './event-stream';
import { StreamLimiter } from './stream-limiter';
import type { StreamBus } from './stream-bus';

/** A bus whose subscribers the test can inspect and drive. */
function fakeBus() {
  const listeners = new Set<(e: AgentEvent) => void>();
  const closers = new Set<() => void>();
  const bus = {
    subscribe: (l: (e: AgentEvent) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    onClosing: (cb: () => void) => { closers.add(cb); return () => { closers.delete(cb); }; },
  } as unknown as StreamBus;
  return { bus, listeners, closers, emit: (e: AgentEvent) => listeners.forEach((l) => l(e)), close: () => [...closers].forEach((c) => c()) };
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

  it('completes when the bus starts closing, and teardown frees the slot, listener, closer and timer', () => {
    const { bus, listeners, closers, close } = fakeBus();
    const limiter = new StreamLimiter();
    let completed = false;
    open({ bus, limiter, max: 1 }).subscribe({ complete: () => { completed = true; } });
    expect(completed).toBe(false);
    expect(closers.size).toBe(1);

    close();
    expect(completed).toBe(true);
    expect(listeners.size).toBe(0);
    expect(closers.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    // the slot is free again
    const again = open({ bus, limiter, max: 1 }).subscribe();
    expect(listeners.size).toBe(1);
    again.unsubscribe();
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
