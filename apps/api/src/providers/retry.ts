import { UpstreamLlmError } from '../agent/errors';

export interface RetryOptions {
  /** Extra attempts after the first. Default 0 here; createProvider passes LLM_MAX_RETRIES. */
  maxRetries?: number;
  baseDelayMs?: number;
  /** Longest single wait. A Retry-After beyond this is not waited out: the caller gets the error instead. */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const retryable = (status: number) => status === 408 || status === 429 || status >= 500;

/** Retry-After as seconds or an HTTP date (plus the retry-after-ms variant some vendors send). */
function retryAfterMs(res: Response): number | undefined {
  const ms = Number(res.headers.get('retry-after-ms'));
  if (res.headers.get('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms;
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * fetch with retries for what is safe to repeat (a completion has no side effects until the agent runs a tool):
 * network failures, 408, 429 and 5xx, with exponential backoff and full jitter, or the server's Retry-After.
 * Returns the final response for the caller to map (even a failing one); throws only when the network failed
 * on every attempt. `makeInit` runs per attempt so each gets its own timeout signal.
 */
export async function fetchWithRetry(
  provider: string,
  doFetch: typeof fetch,
  url: string,
  makeInit: () => RequestInit,
  { maxRetries = 0, baseDelayMs = 500, maxDelayMs = 30_000, sleep = defaultSleep, random = Math.random }: RetryOptions = {},
): Promise<Response> {
  const backoff = (attempt: number) => random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, makeInit());
    } catch (e) {
      if (attempt >= maxRetries) {
        throw new UpstreamLlmError(provider, 'could not reach the provider', e instanceof Error ? e.message : String(e));
      }
      await sleep(backoff(attempt));
      continue;
    }
    if (res.ok || !retryable(res.status) || attempt >= maxRetries) return res;

    const hint = retryAfterMs(res);
    if (hint !== undefined && hint > maxDelayMs) return res;
    await res.body?.cancel().catch(() => undefined); // free the socket before waiting
    await sleep(hint ?? backoff(attempt));
  }
}
