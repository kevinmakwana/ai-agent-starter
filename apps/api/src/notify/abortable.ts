/**
 * Runs `work` and settles with the first of its result or the signal aborting, which rejects with the fixed message
 * `timed out`. For libraries that take no signal: the work itself is not cancelled, only the wait for it. If the signal
 * is already aborted, `work` is not started.
 */
export function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('timed out'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
    // A late rejection of abandoned work lands on an already-settled promise, so it is not left unhandled.
    work().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
