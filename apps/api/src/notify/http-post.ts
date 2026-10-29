/**
 * POSTs and resolves on 2xx. Failures throw only short, fixed messages: the URL (often a secret) and the library's
 * own error text never leave this function.
 */
export async function postJson(
  fetchFn: typeof fetch,
  url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
): Promise<void> {
  let res: Response;
  try {
    // Redirects are not followed: a 3xx counts as a failure instead of sending the body somewhere else.
    res = await fetchFn(url, { method: 'POST', headers: init.headers, body: init.body, signal: init.signal, redirect: 'manual' });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    throw new Error(name === 'TimeoutError' || name === 'AbortError' ? 'timed out' : 'request failed');
  }
  try {
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  } finally {
    // Free the connection; the body is never read.
    try { await res.body?.cancel(); } catch { /* nothing to free */ }
  }
}
