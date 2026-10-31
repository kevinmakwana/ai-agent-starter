import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { principalOf } from '../auth/principal';

/**
 * Runs after ReviewerGuard. Managing reviewers needs a named admin: demo and key callers have no identity, so they
 * cannot be accountable for it.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const principal = principalOf(ctx.switchToHttp().getRequest<Request>());
    if (principal.kind !== 'reviewer' || principal.role !== 'admin') throw new ForbiddenException('Administrator access required');
    return true;
  }
}
