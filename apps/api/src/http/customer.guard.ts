import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { csrfOk } from '../auth/csrf';
import { principalOf } from '../auth/principal';

/** A signed-in customer (login mode). Reviewers and anonymous callers are refused: these routes are the customer's own. */
@Injectable()
export class CustomerGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const principal = principalOf(req);
    if (principal.kind !== 'customer') throw new UnauthorizedException('Sign in to continue');
    if (!csrfOk(req, principal)) throw new ForbiddenException('Missing X-Requested-By header');
    return true;
  }
}
