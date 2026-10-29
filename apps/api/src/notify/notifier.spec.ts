import type { AgentEvent } from '../events/agent-events';
import { buildNote } from './note';
import { Notifier, type NotifierOptions, type NotifyStore } from './notifier';
import type { Channel, ClaimedAction } from './types';

const row = (id: string, over: Partial<ClaimedAction> = {}): ClaimedAction => ({
  id, toolName: 'issue_refund', toolArgs: { orderId: 11, amount: 18.75 }, createdAt: '2026-10-29T10:00:00.000Z',
  rule: 'always_review', ...over,
});
const CONSOLE = 'https://console.example.com/reviewer';

/** A store that hands out the queued batches in order, then nothing. Tracks concurrent claims. */
function fakeStore(...batches: ClaimedAction[][]) {
  const queue = [...batches];
  const state = { calls: 0, active: 0, maxActive: 0, limits: [] as number[] };
  const store: NotifyStore = {
    async claimUnnotified(limit) {
      state.calls++;
      state.limits.push(limit);
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      try { await Promise.resolve(); return queue.shift() ?? []; } finally { state.active--; }
    },
  };
  return { store, state, push: (b: ClaimedAction[]) => queue.push(b) };
}

const okChannel = (name: string): Channel & { send: jest.Mock } => ({ name, send: jest.fn(async () => undefined) });

function setup(over: Partial<NotifierOptions> & { channels?: Channel[] } = {}) {
  const sleeps: number[] = [];
  const logs: string[] = [];
  const notifier = new Notifier({
    store: fakeStore().store, channels: [], consoleUrl: CONSOLE,
    log: { warn: (m) => logs.push(m) },
    sleep: async (ms) => { sleeps.push(ms); },
    ...over,
  });
  return { notifier, sleeps, logs };
}

describe('Notifier delivery', () => {
  it('sends each claimed row to every channel as buildNote(row) and returns the count', async () => {
    const rows = [row('a1'), row('a2', { toolName: 'cancel_order', toolArgs: { orderId: 5 }, rule: null })];
    const a = okChannel('webhook');
    const b = okChannel('slack');
    const { notifier, logs } = setup({ store: fakeStore(rows).store, channels: [a, b] });
    expect(await notifier.runOnce()).toBe(2);
    for (const ch of [a, b]) {
      expect(ch.send).toHaveBeenCalledTimes(2);
      expect(ch.send.mock.calls.map((c) => c[0])).toEqual(rows.map((r) => buildNote(r, CONSOLE)));
      expect(ch.send.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    }
    expect(logs).toEqual([]);
  });

  it('retries a failing channel with waits of 1000 then 4000 ms and logs nothing when it recovers', async () => {
    const send = jest.fn().mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const { notifier, sleeps, logs } = setup({ store: fakeStore([row('a1')]).store, channels: [{ name: 'webhook', send }] });
    await notifier.runOnce();
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 4000]);
    expect(logs).toEqual([]);
  });

  it('logs one line after three failed attempts, still delivers the other channel and never rejects', async () => {
    const bad: Channel = { name: 'webhook', send: jest.fn(async () => { throw new Error('HTTP 500'); }) };
    const good = okChannel('slack');
    const { notifier, logs } = setup({ store: fakeStore([row('a1')]).store, channels: [bad, good] });
    await expect(notifier.runOnce()).resolves.toBe(1);
    expect(bad.send).toHaveBeenCalledTimes(3);
    expect(good.send).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(['Notification via webhook failed for approval a1: HTTP 500']);
  });

  it('never logs a URL or what follows it, and caps the length', async () => {
    const send = jest.fn(async () => { throw new Error('POST https://hooks.example.com/SECRET failed'); });
    const long: Channel = { name: 'email', send: jest.fn(async () => { throw new Error('x'.repeat(500)); }) };
    const { notifier, logs } = setup({ store: fakeStore([row('a1')]).store, channels: [{ name: 'webhook', send }, long] });
    await notifier.runOnce();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toBe('Notification via webhook failed for approval a1: POST [url] failed');
    expect(logs.join('\n')).not.toMatch(/hooks\.example\.com|SECRET/);
    expect(logs[1]).toBe(`Notification via email failed for approval a1: ${'x'.repeat(120)}`);
  });

  it('aborts an attempt whose send hangs but honours its signal, and counts it as a failure', async () => {
    const send = jest.fn((_n, signal: AbortSignal) =>
      new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const { notifier, logs } = setup({
      store: fakeStore([row('a1')]).store, channels: [{ name: 'webhook', send }], timeoutMs: 20, sleep: async () => {},
    });
    await notifier.runOnce();
    expect(send).toHaveBeenCalledTimes(3);
    expect(logs).toEqual(['Notification via webhook failed for approval a1: timed out']);
  });

  it('does not wait forever for a channel that ignores its signal', async () => {
    const send = jest.fn(() => new Promise<void>(() => undefined));
    const { notifier, logs } = setup({
      store: fakeStore([row('a1')]).store, channels: [{ name: 'webhook', send }], timeoutMs: 20, sleep: async () => {},
    });
    await notifier.runOnce();
    expect(send).toHaveBeenCalledTimes(3);
    expect(logs).toEqual(['Notification via webhook failed for approval a1: timed out']);
  });

  it('logs a failed claim and does not throw', async () => {
    const store: NotifyStore = { claimUnnotified: async () => { throw new Error('db down'); } };
    const { notifier, logs } = setup({ store });
    await expect(notifier.runOnce()).resolves.toBe(0);
    expect(logs).toEqual(['Could not check for new approvals: db down']);
  });

  it('keeps claiming while a pass returns a full batch, and stops at the first short one', async () => {
    const { store, state } = fakeStore([row('a1'), row('a2')], [row('a3'), row('a4')], [row('a5')]);
    const ch = okChannel('webhook');
    const { notifier } = setup({ store, channels: [ch], batch: 2 });
    notifier.request();
    await notifier['running'];
    expect(state.calls).toBe(3);
    expect(state.limits).toEqual([2, 2, 2]);
    expect(ch.send).toHaveBeenCalledTimes(5);
  });
});

describe('Notifier triggers', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function fakeBus() {
    let listener: ((e: AgentEvent) => void) | undefined;
    const unsubscribe = jest.fn(() => { listener = undefined; });
    return {
      bus: { subscribe: (l: (e: AgentEvent) => void) => { listener = l; return unsubscribe; } },
      emit: (e: AgentEvent) => listener?.(e),
      unsubscribe,
      subscribed: () => listener !== undefined,
    };
  }
  const flush = () => jest.advanceTimersByTimeAsync(0);

  it('runs one pass immediately on start', async () => {
    const { store, state } = fakeStore();
    const { notifier } = setup({ store });
    notifier.start(fakeBus().bus);
    await flush();
    expect(state.calls).toBe(1);
    await notifier.stop();
  });

  it('turns a burst of approvals events into one pass, ignores trace and audit, and runs on resync', async () => {
    const { store, state } = fakeStore();
    const { notifier } = setup({ store });
    const b = fakeBus();
    notifier.start(b.bus);
    await flush();
    expect(state.calls).toBe(1);

    b.emit({ kind: 'approvals', conversationId: 'c' });
    await jest.advanceTimersByTimeAsync(100);
    b.emit({ kind: 'approvals', conversationId: 'c' });
    b.emit({ kind: 'approvals', conversationId: 'c' });
    await jest.advanceTimersByTimeAsync(100);
    expect(state.calls).toBe(2);
    await jest.advanceTimersByTimeAsync(1000);
    expect(state.calls).toBe(2);

    b.emit({ kind: 'trace', conversationId: 'c' });
    b.emit({ kind: 'audit', conversationId: 'c' });
    await jest.advanceTimersByTimeAsync(1000);
    expect(state.calls).toBe(2);

    b.emit({ kind: 'resync' });
    await jest.advanceTimersByTimeAsync(200);
    expect(state.calls).toBe(3);
    await notifier.stop();
  });

  it('never runs two passes at once: an event during a pass sets a single follow-up', async () => {
    let release!: () => void;
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const store: NotifyStore = {
      async claimUnnotified() {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        try { if (calls === 1) await new Promise<void>((r) => (release = r)); return []; } finally { active--; }
      },
    };
    const { notifier } = setup({ store });
    const b = fakeBus();
    notifier.start(b.bus);
    await flush();
    expect(calls).toBe(1);

    for (let i = 0; i < 3; i++) { b.emit({ kind: 'approvals', conversationId: 'c' }); await jest.advanceTimersByTimeAsync(250); }
    expect(calls).toBe(1); // still blocked on the first pass
    release();
    await flush();
    expect(calls).toBe(2); // exactly one follow-up
    await jest.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
    await notifier.stop();
  });

  it('sweeps every 60 s, and after stop() no timer fires and the listener is gone', async () => {
    const { store, state } = fakeStore();
    const { notifier } = setup({ store });
    const b = fakeBus();
    notifier.start(b.bus);
    await flush();
    await jest.advanceTimersByTimeAsync(59_999);
    expect(state.calls).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(state.calls).toBe(2);

    b.emit({ kind: 'approvals', conversationId: 'c' }); // pending debounce when stopping
    await notifier.stop();
    expect(b.unsubscribe).toHaveBeenCalledTimes(1);
    expect(b.subscribed()).toBe(false);
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(state.calls).toBe(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stop() waits for the pass in flight, makes retries give up, and closes every channel that can close', async () => {
    const send = jest.fn(async () => { throw new Error('nope'); });
    const close = jest.fn();
    const closing: Channel = { name: 'email', send: jest.fn(async () => undefined), close };
    const plain = okChannel('slack');
    const sleeps: Array<() => void> = [];
    const { notifier, logs } = setup({
      store: fakeStore([row('a1'), row('a2')]).store,
      channels: [{ name: 'webhook', send }, closing, plain],
      sleep: () => new Promise<void>((r) => sleeps.push(r)), // a retry wait that only ends when released
    });
    notifier.start(fakeBus().bus);
    await flush();
    expect(send).toHaveBeenCalledTimes(1); // now waiting to retry

    const stopping = notifier.stop();
    await flush();
    await stopping;
    expect(send).toHaveBeenCalledTimes(1); // gave up without waiting for the sleep
    expect(close).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(['Notification via webhook failed for approval a1: nope']);
    expect(closing.send).toHaveBeenCalledTimes(1); // the second row was not started
    sleeps.forEach((r) => r());
    await flush();
    expect(send).toHaveBeenCalledTimes(1);

    notifier.request(); // stopped: nothing more happens
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
