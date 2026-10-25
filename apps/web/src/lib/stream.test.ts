import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SseMessage } from './sse';
import { backoffDelay, openStream, type StreamStatus } from './stream';

const encoder = new TextEncoder();

/** A response whose body the test feeds by hand; reading it fails with an AbortError once `signal` aborts, like a real fetch. */
function liveResponse(signal: AbortSignal | null | undefined, status = 200) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')), { once: true });
    },
  });
  return {
    response: new Response(body, { status }),
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

interface Call {
  url: string;
  init: RequestInit;
  send(text: string): void;
  end(): void;
}

/** A fake fetch: call n answers with `statuses[n]` (default 200) and the call is recorded; failed statuses carry an empty body. */
function fakeFetch(statuses: number[] = []) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const status = statuses[calls.length] ?? 200;
    const live = liveResponse(init?.signal, status);
    calls.push({ url: String(input), init: init ?? {}, send: live.send, end: live.end });
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return live.response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function setup(options: Parameters<typeof openStream>[3] & object = {}, statuses: number[] = []) {
  const fake = fakeFetch(statuses);
  const statusLog: StreamStatus[] = [];
  const messages: SseMessage[] = [];
  const fatals: number[] = [];
  const close = openStream(
    'http://api.test/stream',
    { 'x-api-key': 'k' },
    { onMessage: (m) => messages.push(m), onStatus: (s) => statusLog.push(s), onFatal: (s) => fatals.push(s) },
    { fetchImpl: fake.fetchImpl, sleep: async () => undefined, random: () => 1, ...options },
  );
  return { ...fake, statusLog, messages, fatals, close };
}

/** Poll until `cond` holds, failing only after a generous wall-clock deadline so slow or fast machines behave the same. */
async function until(cond: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(cond(), 'condition was not reached');
}

/** Give the client plenty of turns to do something it should not. */
async function settle() {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('backoffDelay', () => {
  const range = { min: 1000, max: 15000 };
  const full = [1000, 2000, 4000, 8000, 15000, 15000, 15000];

  it('doubles per attempt up to the cap', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, range, () => 1)), full);
  });
  it('is half the delay at the bottom of the jitter range', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, range, () => 0)), full.map((d) => d / 2));
  });
});

describe('openStream', () => {
  it('goes connecting then live and delivers messages across chunk boundaries', async () => {
    const s = setup();
    assert.deepEqual(s.statusLog, ['connecting']);
    await until(() => s.calls.length === 1);
    await until(() => s.statusLog.length === 2);
    assert.deepEqual(s.statusLog, ['connecting', 'live']);

    s.calls[0]!.send(': connected\n\nevent: tra');
    s.calls[0]!.send('ce\ndata: {"conversationId":"x"}\n');
    s.calls[0]!.send('\n');
    await until(() => s.messages.length === 1);
    assert.deepEqual(s.messages, [{ event: 'trace', data: '{"conversationId":"x"}' }]);
    s.close();
  });

  for (const status of [401, 403, 404]) {
    it(`reports ${status} as fatal and does not retry`, async () => {
      const s = setup({}, [status]);
      await until(() => s.fatals.length === 1);
      await settle();
      assert.deepEqual(s.fatals, [status]);
      assert.deepEqual(s.statusLog, ['connecting', 'down']);
      assert.equal(s.calls.length, 1);
    });
  }

  it('reconnects after the server ends the stream', async () => {
    const s = setup();
    await until(() => s.calls.length === 1);
    await until(() => s.statusLog.length === 2);
    s.calls[0]!.end();
    await until(() => s.calls.length === 2);
    await until(() => s.statusLog.length === 4);
    assert.deepEqual(s.statusLog, ['connecting', 'live', 'down', 'live']);
    s.close();
  });

  it('retries after a 500 without reporting it as fatal', async () => {
    const s = setup({}, [500]);
    await until(() => s.calls.length === 2);
    await until(() => s.statusLog.length === 3);
    assert.deepEqual(s.statusLog, ['connecting', 'down', 'live']);
    assert.deepEqual(s.fatals, []);
    s.close();
  });

  it('waits the backoff delay between attempts and resets it after a successful connect', async () => {
    const delays: number[] = [];
    const s = setup({ sleep: async (ms) => void delays.push(ms), backoff: { min: 100, max: 1000 } }, [500, 500, 200]);
    await until(() => s.calls.length === 3);
    await until(() => s.statusLog.at(-1) === 'live');
    s.calls[2]!.end();
    await until(() => s.calls.length === 4);
    assert.deepEqual(delays.slice(0, 3), [100, 200, 100]);
    s.close();
  });

  it('aborts and retries an attempt that goes quiet for idleMs', async () => {
    const s = setup({ idleMs: 20 });
    await until(() => s.calls.length === 1);
    await until(() => s.calls.length === 2);
    assert.equal(s.calls[0]!.init.signal?.aborted, true);
    s.close();
  });

  it('close() aborts the in-flight request and stops further status callbacks', async () => {
    const s = setup();
    await until(() => s.statusLog.length === 2);
    s.close();
    assert.equal(s.calls[0]!.init.signal?.aborted, true);
    const seen = [...s.statusLog];
    await settle();
    assert.deepEqual(s.statusLog, seen);
    assert.equal(s.calls.length, 1);
  });

  it('sends the given headers', async () => {
    const s = setup();
    await until(() => s.calls.length === 1);
    assert.equal(s.calls[0]!.url, 'http://api.test/stream');
    assert.deepEqual(s.calls[0]!.init.headers, { 'x-api-key': 'k' });
    s.close();
  });
});
