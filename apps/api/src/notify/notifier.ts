import { Logger } from '@nestjs/common';
import type { AgentEvent } from '../events/agent-events';
import { abortable } from './abortable';
import { buildNote } from './note';
import type { ApprovalNote, Channel, ClaimedAction } from './types';

export interface NotifyStore {
  /** Marks up to `limit` pending, not-yet-announced actions as announced and returns them. */
  claimUnnotified(limit: number): Promise<ClaimedAction[]>;
  /** Gives claimed rows back so a later pass (or another replica) announces them. Only for rows no delivery began for. */
  release?(ids: string[]): Promise<void>;
}

export interface NotifierOptions {
  store: NotifyStore;
  channels: Channel[];
  consoleUrl: string;
  log?: { warn(message: string): void };
  sleep?: (ms: number) => Promise<void>;
  /** Per attempt. */
  timeoutMs?: number;
  /** Waits between attempts, so `[1000, 4000]` means 3 attempts. */
  backoffMs?: number[];
  batch?: number;
  sweepMs?: number;
  debounceMs?: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });

/** Logged text never carries a URL (webhook URLs hold secrets) and is short. */
const safe = (err: unknown): string =>
  String(err instanceof Error ? err.message : err).replace(/https?:\/\/\S+/g, '[url]').slice(0, 120);

/**
 * Announces new pending approvals. Each pass claims a batch (the claim commits first, so delivery is at most once)
 * and sends every note to every channel. Channels fail, retry and time out independently, and a pass never throws.
 * Rows claimed but not yet started when `stop()` lands are released for the next process; a row whose delivery began
 * counts as attempted and is never released.
 * Passes never overlap: a trigger during a pass sets one follow-up pass.
 */
export class Notifier {
  private readonly store: NotifyStore;
  private readonly channels: Channel[];
  private readonly consoleUrl: string;
  private readonly log: { warn(message: string): void };
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly backoffMs: number[];
  private readonly batch: number;
  private readonly sweepMs: number;
  private readonly debounceMs: number;

  private running: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private unsubscribe: (() => void) | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly stopSignal: Promise<void>;
  private signalStop!: () => void;

  constructor(opts: NotifierOptions) {
    this.store = opts.store;
    this.channels = opts.channels;
    this.consoleUrl = opts.consoleUrl;
    this.log = opts.log ?? new Logger('Notifier');
    this.sleep = opts.sleep ?? defaultSleep;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.backoffMs = opts.backoffMs ?? [1000, 4000];
    this.batch = opts.batch ?? 20;
    this.sweepMs = opts.sweepMs ?? 60_000;
    this.debounceMs = opts.debounceMs ?? 200;
    this.stopSignal = new Promise<void>((resolve) => { this.signalStop = resolve; });
  }

  /** Claims up to `batch` actions and delivers them. Resolves with how many were claimed; never rejects. */
  async runOnce(): Promise<number> {
    if (this.stopped) return 0;
    let rows: ClaimedAction[];
    try {
      rows = await this.store.claimUnnotified(this.batch);
    } catch (e) {
      this.log.warn(`Could not check for new approvals: ${safe(e)}`);
      return 0;
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (this.stopped) { await this.release(rows.slice(i)); break; }
      const note = buildNote(row, this.consoleUrl);
      await Promise.allSettled(this.channels.map((channel) => this.deliver(channel, note)));
    }
    return rows.length;
  }

  /** Best effort: a row that cannot be released stays marked as announced. */
  private async release(skipped: ClaimedAction[]): Promise<void> {
    try {
      await this.store.release?.(skipped.map((r) => r.id));
    } catch (e) {
      this.log.warn(`Could not release ${skipped.length} unsent approval(s): ${safe(e)}`);
    }
  }

  /** Asks for a pass. Calls during a pass coalesce into one follow-up pass. */
  request(): void {
    if (this.stopped) return;
    if (this.running) { this.again = true; return; }
    this.running = this.drain().finally(() => {
      this.running = undefined;
      if (this.again) { this.again = false; this.request(); }
    });
  }

  start(bus: { subscribe(l: (e: AgentEvent) => void): () => void }): void {
    if (this.stopped || this.unsubscribe) return;
    this.unsubscribe = bus.subscribe((e) => {
      if (e.kind === 'approvals' || e.kind === 'resync') this.schedule();
    });
    this.sweepTimer = setInterval(() => this.request(), this.sweepMs);
    this.sweepTimer.unref();
    this.request();
  }

  /** Stops triggers, lets the pass in flight finish (retries give up), and closes the channels. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.signalStop();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearInterval(this.sweepTimer);
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    await this.running;
    await Promise.allSettled(this.channels.map(async (channel) => { await channel.close?.(); }));
  }

  /** A burst of events becomes one pass, `debounceMs` after the first. */
  private schedule(): void {
    if (this.stopped || this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => { this.debounceTimer = undefined; this.request(); }, this.debounceMs);
    this.debounceTimer.unref();
  }

  private async drain(): Promise<void> {
    while ((await this.runOnce()) === this.batch) { /* a full batch: there may be more */ }
  }

  private async deliver(channel: Channel, note: ApprovalNote): Promise<void> {
    let failure: unknown;
    let failed = false;
    for (let attempt = 0; attempt <= this.backoffMs.length; attempt++) {
      if (this.stopped) break;
      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        // Raced against the signal too, so a channel that ignores it cannot hang the pass.
        await abortable(signal, () => channel.send(note, signal));
        return;
      } catch (e) {
        failed = true;
        failure = e;
      }
      if (attempt < this.backoffMs.length) await Promise.race([this.sleep(this.backoffMs[attempt]), this.stopSignal]);
    }
    if (failed) this.log.warn(`Notification via ${channel.name} failed for approval ${note.id}: ${safe(failure)}`);
  }
}
