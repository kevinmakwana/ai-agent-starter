import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestId } from '../logging/request-context';

/** A client may supply its own id (a trace id from a gateway); anything else is replaced, so a header cannot inject log content. */
const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

const log = new Logger('Http');

/** Probes hit these every few seconds; logging them would bury everything else. */
const QUIET = /^\/health(\/|$)/;

/**
 * Gives every request an id (echoed as `X-Request-Id`), makes it visible to all logging while the request is served, and writes
 * one access line when it ends: method, path WITHOUT the query string, status and duration. Never headers, cookies or bodies.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get('x-request-id');
  const id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', id);
  const started = process.hrtime.bigint();
  res.once('close', () => {
    if (QUIET.test(req.path)) return;
    const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    // The id is passed explicitly: this runs from a socket event, where the async context is not guaranteed.
    log.log({ msg: 'request', requestId: id, method: req.method, path: req.path, status: res.statusCode, durationMs });
  });
  runWithRequestId(id, next);
}
