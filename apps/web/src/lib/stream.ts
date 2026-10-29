import { SseParser, type SseMessage } from './sse';

export type StreamStatus = 'connecting' | 'live' | 'down';

export interface StreamHandlers {
  onMessage(m: SseMessage): void;
  onStatus(s: StreamStatus): void;
  /** Called once for a 401, 403 or 404, after which the stream stops retrying. */
  onFatal?(httpStatus: number): void;
}

export interface StreamOptions {
  fetchImpl?: typeof fetch;
  backoff?: { min: number; max: number };
  /** Abort and retry an attempt that delivers no bytes for this long (the server pings every 15 s). */
  idleMs?: number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** `min * 2^attempt` capped at `max`, then jittered to between half and all of it. */
export function backoffDelay(
  attempt: number,
  range: { min: number; max: number },
  random: () => number = Math.random,
): number {
  const base = Math.min(range.max, range.min * 2 ** attempt);
  return base * (0.5 + random() / 2);
}

const FATAL = new Set([401, 403, 404]);

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Opens an SSE stream with fetch (EventSource cannot send headers) and keeps it open: reconnects with
 * backoff after any failure or end, and gives up only on 401/403/404. Returns a function that closes it.
 */
export function openStream(
  url: string,
  headers: Record<string, string>,
  handlers: StreamHandlers,
  options: StreamOptions = {},
): () => void {
  const {
    fetchImpl = fetch,
    backoff = { min: 1000, max: 15000 },
    idleMs = 45_000,
    random = Math.random,
    sleep = wait,
  } = options;
  const closed = new AbortController();
  const status = (s: StreamStatus) => {
    if (!closed.signal.aborted) handlers.onStatus(s);
  };

  void (async () => {
    let attempt = 0;
    status('connecting');
    while (!closed.signal.aborted) {
      const run = new AbortController();
      const stopRun = () => run.abort();
      closed.signal.addEventListener('abort', stopRun, { once: true });
      let idle: ReturnType<typeof setTimeout> | undefined;
      const armIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(stopRun, idleMs);
      };
      try {
        armIdle();
        const res = await fetchImpl(url, { headers, signal: run.signal, cache: 'no-store' });
        if (FATAL.has(res.status)) {
          void res.body?.cancel().catch(() => undefined);
          status('down');
          handlers.onFatal?.(res.status);
          return;
        }
        if (res.ok && res.body) {
          // Headers alone prove little: a proxy can pass them and buffer the body. `live` waits for the first
          // chunk (the server writes one the moment a stream opens).
          let first = true;
          const parser = new SseParser();
          const decoder = new TextDecoder();
          const reader = res.body.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            armIdle();
            if (first) { first = false; attempt = 0; status('live'); }
            for (const m of parser.push(decoder.decode(value, { stream: true }))) handlers.onMessage(m);
          }
        } else {
          void res.body?.cancel().catch(() => undefined);
        }
      } catch {
        // Aborted, network error or a reader failure: fall through to the retry below.
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
