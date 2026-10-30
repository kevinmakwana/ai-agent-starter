import type { Request } from 'express';
import type { Principal } from './principal';

export const CSRF_HEADER = 'x-requested-by';
export const CSRF_VALUE = 'reviewer-console';

/**
 * A request authenticated by the session cookie must prove it came from our own page when it changes anything: a
 * cross-origin page cannot add this header without a CORS preflight, which the exact-origin CORS list refuses.
 * Key and demo callers send no ambient credentials, so they are exempt.
 */
export function csrfOk(req: Pick<Request, 'method' | 'headers'>, principal: Principal): boolean {
  if (principal.kind !== 'reviewer') return true;
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  return req.headers[CSRF_HEADER] === CSRF_VALUE;
}
