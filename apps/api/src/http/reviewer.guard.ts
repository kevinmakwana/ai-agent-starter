import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { csrfOk } from '../auth/csrf';
import { isReviewerPrincipal, principalOf } from '../auth/principal';

/** True when no reviewer key is configured (open demo mode) or the request carries the right one. */
export function isReviewer(reviewerApiKey: string, authorization: string | undefined): boolean {
  if (!reviewerApiKey) return true;
  const header = authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(reviewerApiKey);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Gate for reviewer/operator routes. It trusts only `req.principal`, which PrincipalMiddleware derives from the session
 * cookie, the shared key or (zero-config demo) nothing. A cookie request that changes state must also pass the CSRF check.
 */
@Injectable()
export class ReviewerGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const principal = principalOf(req);
    if (!isReviewerPrincipal(principal)) throw new UnauthorizedException('Reviewer credentials required');
    if (!csrfOk(req, principal)) throw new ForbiddenException('Missing X-Requested-By header');
    return true;
  }
}
