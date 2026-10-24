/** Counts open streams per key so a client (or a bug) cannot hold an unbounded number of connections. */
export class StreamLimiter {
  private readonly open = new Map<string, number>();

  /** A release function, or null when `key` is already at `max`. Releasing twice is harmless. */
  acquire(key: string, max: number): (() => void) | null {
    const n = this.open.get(key) ?? 0;
    if (n >= max) return null;
    this.open.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(key) ?? 1) - 1;
      if (left <= 0) this.open.delete(key); else this.open.set(key, left);
    };
  }
}
