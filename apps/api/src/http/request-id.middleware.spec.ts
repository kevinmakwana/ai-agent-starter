import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { currentRequestId } from '../logging/request-context';
import { requestId } from './request-id.middleware';

const fake = (headers: Record<string, string> = {}, path = '/conversations') => {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
  });
  const req = { path, method: 'GET', get: (k: string) => headers[k.toLowerCase()] };
  let seen: string | undefined;
  const next: NextFunction = () => {
    seen = currentRequestId();
  };
  requestId(req as unknown as Request, res as unknown as Response, next);
  return { res, seen: () => seen };
};

describe('requestId middleware', () => {
  let logged: unknown[];
  beforeEach(() => {
    logged = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void logged.push(m));
  });
  afterEach(() => jest.restoreAllMocks());

  it('generates an id, echoes it, and exposes it to the code that runs next', () => {
    const { res, seen } = fake();
    expect(res.headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen()).toBe(res.headers['X-Request-Id']);
  });

  it('keeps a well-formed id from the caller', () => {
    const { res, seen } = fake({ 'x-request-id': 'trace-ABC_123.xyz' });
    expect(res.headers['X-Request-Id']).toBe('trace-ABC_123.xyz');
    expect(seen()).toBe('trace-ABC_123.xyz');
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(65)],
    ['has a space', 'abc def ghi jkl'],
    ['has a newline', 'abcdefgh\n{"level":"error"}'],
    ['has a quote', 'abc"defghij'],
  ])('replaces an id that is %s', (_why, bad) => {
    const { res } = fake({ 'x-request-id': bad });
    expect(res.headers['X-Request-Id']).not.toBe(bad);
    expect(res.headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('writes one access line when the response ends, with method, path, status and duration and nothing else', () => {
    const { res } = fake({ authorization: 'Bearer SECRET', cookie: 'a=SECRET' }, '/approvals');
    res.statusCode = 403;
    res.emit('close');
    expect(logged).toEqual([
      {
        msg: 'request',
        requestId: res.headers['X-Request-Id'],
        method: 'GET',
        path: '/approvals',
        status: 403,
        durationMs: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(logged)).not.toContain('SECRET');
  });

  it('does not log health probes', () => {
    for (const path of ['/health', '/health/live', '/health/ready']) fake({}, path).res.emit('close');
    expect(logged).toEqual([]);
  });
});
