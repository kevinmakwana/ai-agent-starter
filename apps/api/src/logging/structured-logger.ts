import type { LogLevel, LoggerService } from '@nestjs/common';
import { currentRequestId } from './request-context';

export type LogFormat = 'json' | 'pretty';

type Level = 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal';

/** Keys whose values never reach a log line, wherever they sit in a logged object. */
const SENSITIVE = /authorization|cookie|password|passwd|secret|token|api[-_]?key/i;
const RESERVED = new Set(['time', 'level', 'context', 'requestId', 'msg', 'stack']);
const MAX_MESSAGE = 2000;
const MAX_DEPTH = 4;

function redact(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1)]));
  }
  return typeof value === 'string' && value.length > MAX_MESSAGE ? `${value.slice(0, MAX_MESSAGE)}…` : value;
}

export interface LogSink {
  out(line: string): void;
  err(line: string): void;
}

const processSink: LogSink = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/**
 * Nest `LoggerService` that writes one line per event: JSON for log collectors, or a readable line for a terminal. Every
 * line carries the id of the request being served (when there is one). Objects passed as the message become fields; keys
 * that look like credentials are replaced, and JSON escaping keeps a message from forging a second log line.
 */
export class StructuredLogger implements LoggerService {
  constructor(
    private readonly format: LogFormat,
    private readonly sink: LogSink = processSink,
  ) {}

  log(message: unknown, ...params: unknown[]) {
    this.write('log', message, params);
  }
  error(message: unknown, ...params: unknown[]) {
    this.write('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]) {
    this.write('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]) {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]) {
    this.write('verbose', message, params);
  }
  fatal(message: unknown, ...params: unknown[]) {
    this.write('fatal', message, params);
  }
  setLogLevels(_levels: LogLevel[]) {
    /* every level is written; collectors filter */
  }

  private write(level: Level, message: unknown, params: unknown[]) {
    // Nest passes the context name last, and for errors a stack just before it.
    const strings = params.filter((p): p is string => typeof p === 'string');
    const context = strings.length ? strings[strings.length - 1] : undefined;
    const stack = level === 'error' || level === 'fatal' ? (strings.length > 1 ? strings[0] : undefined) : undefined;

    let fields: Record<string, unknown> = {};
    let msg: string;
    if (message instanceof Error) {
      msg = message.message;
    } else if (message && typeof message === 'object') {
      const { msg: m, message: m2, ...rest } = message as Record<string, unknown>;
      msg = String(m ?? m2 ?? '');
      fields = redact(rest) as Record<string, unknown>;
    } else {
      msg = String(message);
    }
    if (msg.length > MAX_MESSAGE) msg = `${msg.slice(0, MAX_MESSAGE)}…`;
    for (const key of Object.keys(fields)) if (RESERVED.has(key) && key !== 'requestId') delete fields[key];

    const requestId = typeof fields.requestId === 'string' ? fields.requestId : currentRequestId();
    delete fields.requestId;
    const entry = {
      time: new Date().toISOString(),
      level,
      ...(context && { context }),
      ...(requestId && { requestId }),
      msg,
      ...fields,
      ...(stack && { stack }),
    };

    const line = this.format === 'json' ? JSON.stringify(entry) : this.pretty(entry);
    (level === 'error' || level === 'fatal' ? this.sink.err : this.sink.out).call(this.sink, line);
  }

  private pretty(e: Record<string, unknown>): string {
    const { time, level, context, requestId, msg, stack, ...fields } = e;
    const extra = Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
    const where = [context && `[${String(context)}]`, requestId && `(${String(requestId).slice(0, 8)})`].filter(Boolean).join(' ');
    return `${String(time).slice(11, 19)} ${String(level).toUpperCase().padEnd(5)} ${where} ${String(msg).replace(/\s*\n\s*/g, ' ⏎ ')}${extra}${stack ? `\n${String(stack)}` : ''}`;
  }
}
