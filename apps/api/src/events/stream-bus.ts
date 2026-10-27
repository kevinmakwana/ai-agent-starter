import type { BeforeApplicationShutdown, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Client } from 'pg';
import { AGENT_EVENTS_CHANNEL, type AgentEvent, parseEvent } from './agent-events';

/** The slice of pg.Client that StreamBus needs, so tests can substitute a fake. */
export interface ListenConnection {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: string, cb: (...args: any[]) => void): unknown;
}

/**
 * A dedicated connection: a pooled one can be recycled, which would silently drop the LISTEN. TCP keepalive probes
 * start after 10 s (pg's default is the OS's, about two hours) and a connect to a blackholed host gives up after 10 s.
 */
export const pgListenConnection = (connectionString: string): ListenConnection =>
  new Client({
    connectionString,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'agent-events-listener',
  });

export interface StreamBusOptions {
  /** Returns a fresh, not-yet-connected connection each time. */
  connect: () => ListenConnection;
  /** Reconnect delay doubles from `min` up to `max`. */
  retryMs?: { min: number; max: number };
  /** How often an idle listener is probed with `SELECT 1`, and how long the probe may take before the connection counts as lost. */
  heartbeat?: { intervalMs: number; timeoutMs: number };
  onError?: (e: unknown) => void;
}

/**
 * One LISTEN connection fanned out to in-process subscribers. If the connection is lost (or never came up) it
 * reconnects with backoff and, once listening again, tells every subscriber to `resync`: events may have been
 * missed in between, and signals carry no replay.
 */
export class StreamBus implements OnModuleInit, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  private readonly closers = new Set<() => void>();
  private conn: ListenConnection | null = null;
  private timer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stopped = false;
  private degraded = false;

  constructor(private readonly opts: StreamBusOptions) {}

  subscribe(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Calls `cb` once when the app begins shutting down (immediately if it already has), so open streams can end
   * themselves: Nest's HTTP server close waits for open connections, and an SSE response never ends on its own.
   */
  onClosing(cb: () => void): () => void {
    if (this.stopped) { cb(); return () => undefined; }
    this.closers.add(cb);
    return () => { this.closers.delete(cb); };
  }

  async onModuleInit(): Promise<void> {
    await this.open();
  }

  /** Runs before Nest closes the HTTP server, which is the moment open streams must be told to finish. */
  beforeApplicationShutdown(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.heartbeatTimer);
    const closers = [...this.closers];
    this.closers.clear();
    for (const close of closers) {
      try { close(); } catch (e) { this.opts.onError?.(e); }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.heartbeatTimer);
    const conn = this.conn;
    this.conn = null;
    await conn?.end().catch(() => undefined);
  }

  private emit(event: AgentEvent) {
    for (const listener of this.listeners) {
      try { listener(event); } catch (e) { this.opts.onError?.(e); }
    }
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    const conn = this.opts.connect();
    const lost = () => {
      if (this.conn !== conn) return;
      this.conn = null;
      clearTimeout(this.heartbeatTimer);
      this.degraded = true;
      this.scheduleRetry();
    };
    // Attached before connecting so an error during connect is never unhandled.
    conn.on('error', (e) => { this.opts.onError?.(e); lost(); conn.end().catch(() => undefined); });
    conn.on('end', lost);
    conn.on('notification', (m: { payload?: string }) => {
      const event = parseEvent(m.payload);
      if (event) this.emit(event);
    });
    try {
      await conn.connect();
      await conn.query(`LISTEN ${AGENT_EVENTS_CHANNEL}`);
    } catch (e) {
      this.opts.onError?.(e);
      this.degraded = true;
      conn.end().catch(() => undefined);
      this.scheduleRetry();
      return;
    }
    if (this.stopped) { conn.end().catch(() => undefined); return; }
    this.conn = conn;
    this.attempt = 0;
    this.scheduleHeartbeat(conn, lost);
    if (this.degraded) {
      this.degraded = false;
      this.emit({ kind: 'resync' });
    }
  }

  /**
   * A connection that died silently (a NAT or proxy dropping an idle flow) raises neither `error` nor `end`, so
   * probe it: a failed or slow `SELECT 1` is treated like an `error`, which reconnects and then emits one `resync`.
   */
  private scheduleHeartbeat(conn: ListenConnection, lost: () => void) {
    const { intervalMs, timeoutMs } = this.opts.heartbeat ?? { intervalMs: 30_000, timeoutMs: 10_000 };
    this.heartbeatTimer = setTimeout(async () => {
      let guard: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          conn.query('SELECT 1'),
          new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('listener heartbeat timed out')), timeoutMs); }),
        ]);
      } catch (e) {
        if (this.conn === conn) this.opts.onError?.(e);
        lost();
        conn.end().catch(() => undefined);
        return;
      } finally {
        clearTimeout(guard);
      }
      if (this.conn === conn && !this.stopped) this.scheduleHeartbeat(conn, lost);
    }, intervalMs);
    this.heartbeatTimer.unref();
  }

  private scheduleRetry() {
    if (this.stopped || this.timer) return;
    const { min, max } = this.opts.retryMs ?? { min: 200, max: 5000 };
    const delay = Math.min(max, min * 2 ** this.attempt++);
    this.timer = setTimeout(() => { this.timer = undefined; void this.open(); }, delay);
  }
}
