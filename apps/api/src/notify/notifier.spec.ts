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

  it('gives a channel its own per-attempt timeout instead of the notifier default', async () => {
    const send = jest.fn(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 60).unref(); }); });
    const slow: Channel = { name: 'email', timeoutMs: 500, send };
    const fast = { name: 'webhook', send: jest.fn(send) };
    const { notifier, logs } = setup({
      store: fakeStore([row('a1')]).store, channels: [slow, fast], timeoutMs: 20, backoffMs: [], sleep: async () => {},
    });
    await notifier.runOnce();
    // The 60 ms send outlives the 20 ms default (webhook) but not the 500 ms channel allowance (email).
    expect(logs).toEqual(['Notification via webhook failed for approval a1: timed out']);
  });

  it('uses the notifier timeout when the channel has none', async () => {
    const send = jest.fn(() => new Promise<void>(() => undefined));
    const { notifier, logs } = setup({
      store: fakeStore([row('a1')]).store, channels: [{ name: 'webhook', send }], timeoutMs: 20, backoffMs: [], sleep: async () => {},
    });
    await notifier.runOnce();
    expect(logs).toEqual(['Notification via webhook failed for approval a1: timed out']);
  });

  it('claims 5 at a time by default', async () => {
    const { store, state } = fakeStore();
    const { notifier } = setup({ store });
    await notifier.runOnce();
    expect(state.limits).toEqual([5]);
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

describe('Notifier request() never leaks a rejection', () => {
  it('logs and carries on when a pass throws, so nothing becomes an unhandled rejection', async () => {
    // A null row makes buildNote throw inside the pass, which runOnce does not guard.
    const { notifier, logs } = setup({ store: fakeStore([null as unknown as ClaimedAction]).store, channels: [okChannel('webhook')] });
    notifier.request();
    await expect(notifier['running']).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^Notification pass failed: /);
    expect(notifier['running']).toBeUndefined();
  });

  it('still runs the follow-up pass after a pass that threw', async () => {
    const ch = okChannel('webhook');
    const { store } = fakeStore([null as unknown as ClaimedAction], [row('a1')]);
    const { notifier } = setup({ store, channels: [ch] });
    notifier.request();
    notifier.request();
    while (notifier['running']) await notifier['running'];
    expect(ch.send).toHaveBeenCalledTimes(1);
  });

  it('survives a store whose claim throws synchronously or asynchronously', async () => {
    for (const claimUnnotified of [
      (() => { throw new Error('sync boom'); }) as unknown as NotifyStore['claimUnnotified'],
      async () => { throw new Error('async boom'); },
    ]) {
      const { notifier, logs } = setup({ store: { claimUnnotified } });
      notifier.request();
      await expect(notifier['running']).resolves.toBeUndefined();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/^Could not check for new approvals: (sync|async) boom$/);
    }
  });

  it('survives a channel whose send throws synchronously', async () => {
    const bad: Channel = { name: 'webhook', send: (() => { throw new Error('sync send'); }) as unknown as Channel['send'] };
    const { notifier, logs } = setup({ store: fakeStore([row('a1')]).store, channels: [bad], backoffMs: [] });
    notifier.request();
    await expect(notifier['running']).resolves.toBeUndefined();
    expect(logs).toEqual(['Notification via webhook failed for approval a1: sync send']);
  });
});

describe('Notifier release on stop', () => {
  const releasingStore = (...batches: ClaimedAction[][]) => {
    const { store } = fakeStore(...batches);
    const release = jest.fn(async (_ids: string[]) => undefined);
    return { store: { ...store, release } as NotifyStore, release };
  };

  it('releases rows it never started when stop() lands mid-pass, and never the one it attempted', async () => {
    const { store, release } = releasingStore([row('a1'), row('a2'), row('a3')]);
    let stopping: Promise<void> | undefined;
    const ch: Channel = { name: 'webhook', send: jest.fn(async () => { stopping = notifier.stop(); }) };
    const { notifier } = setup({ store, channels: [ch] });
    await expect(notifier.runOnce()).resolves.toBe(3);
    await stopping;
    expect(ch.send).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(['a2', 'a3']);
  });

  it('releases every claimed row when stop() lands during the claim', async () => {
    let finishClaim!: (rows: ClaimedAction[]) => void;
    const release = jest.fn(async (_ids: string[]) => undefined);
    const store: NotifyStore = { claimUnnotified: () => new Promise((r) => (finishClaim = r)), release };
    const ch = okChannel('webhook');
    const { notifier } = setup({ store, channels: [ch] });
    const pass = notifier.runOnce();
    await Promise.resolve();
    const stopping = notifier.stop();
    finishClaim([row('a1'), row('a2')]);
    await expect(pass).resolves.toBe(2);
    await stopping;
    expect(ch.send).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(['a1', 'a2']);
  });

  it('does not release when every claimed row was started', async () => {
    const { store, release } = releasingStore([row('a1'), row('a2')]);
    const ch = okChannel('webhook');
    const { notifier } = setup({ store, channels: [ch] });
    await notifier.runOnce();
    await notifier.stop();
    expect(ch.send).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
  });

  it('does not release a row whose retries were cut short by stop()', async () => {
    const { store, release } = releasingStore([row('a1')]);
    const send = jest.fn(async () => { throw new Error('nope'); });
    const { notifier } = setup({ store, channels: [{ name: 'webhook', send }], sleep: () => new Promise<void>(() => undefined) });
    const pass = notifier.runOnce();
    await new Promise((r) => setImmediate(r));
    await notifier.stop();
    await pass;
    expect(send).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it('logs a failed release without a URL and does not throw', async () => {
    const release = jest.fn(async () => { throw new Error('POST https://db.example.com/secret refused'); });
    let finishClaim!: (rows: ClaimedAction[]) => void;
    const store: NotifyStore = { claimUnnotified: () => new Promise((r) => (finishClaim = r)), release };
    const { notifier, logs } = setup({ store, channels: [okChannel('webhook')] });
    const pass = notifier.runOnce();
    await Promise.resolve();
    const stopping = notifier.stop();
    finishClaim([row('a1')]);
    await expect(pass).resolves.toBe(1);
    await stopping;
    expect(logs).toEqual(['Could not release 1 unsent approval(s): POST [url] refused']);
  });

  it('works with a store that has no release', async () => {
    const { store } = fakeStore([row('a1')]);
    const { notifier } = setup({ store, channels: [okChannel('webhook')] });
    const pass = notifier.runOnce();
    await notifier.stop();
    await expect(pass).resolves.toBe(1);
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
