import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { hasCsrfHeader } from '../auth/csrf';

/**
 * Every non-read call on /customer-auth must come from our own page (a cross-origin page cannot add this header without
 * a CORS preflight). Needed even before sign-in: it stops a foreign page from triggering mail or planting a session.
 */
@Injectable()
export class CsrfHeaderGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    if (!hasCsrfHeader(req)) throw new ForbiddenException('Missing X-Requested-By header');
    return true;
  }
}
