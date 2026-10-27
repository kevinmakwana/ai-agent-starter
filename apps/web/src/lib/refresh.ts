/**
 * Latest-wins sequencing: `next()` starts a request and returns a check that stays true only until the next
 * request starts, so a slow older response can never overwrite a newer one.
 */
export function createLatest(): { next(): () => boolean } {
  let seq = 0;
  return {
    next() {
      const mine = ++seq;
      return () => mine === seq;
    },
  };
}

/**
 * Runs `fn` one at a time. A call made while it is running does not start a second run: it asks for one more run
 * after the current one (its argument merged into any already waiting), however many calls arrive meanwhile. Every
 * call's promise resolves once the run that covers it is done. `fn` is expected to handle its own errors.
 */
export function singleFlight<A>(fn: (arg: A) => Promise<void>, merge: (queued: A, next: A) => A): (arg: A) => Promise<void> {
  let running: Promise<void> | null = null;
  let waiting: { arg: A } | null = null;

  const drain = async (first: A): Promise<void> => {
    let arg = first;
    try {
      for (;;) {
        await fn(arg);
        if (!waiting) return;
        arg = waiting.arg;
        waiting = null;
      }
    } finally {
      running = null; // cleared in the same turn as the last check, so a call can never queue behind a finished loop
      waiting = null;
    }
  };

  return (arg) => {
    if (running) {
      waiting = waiting ? { arg: merge(waiting.arg, arg) } : { arg };
      return running;
    }
    running = drain(arg);
    return running;
  };
}
