import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import { csrfOk } from '../auth/csrf';
import { isReviewerPrincipal, principalOf } from '../auth/principal';
import { PgAgentStore } from '../db/pg-agent.store';

export const CONVERSATION_TOKEN_HEADER = 'x-conversation-token';

/**
 * A conversation is readable/writable by whoever holds its access token (returned once, on creation),
 * or by a reviewer. Unknown ids and wrong tokens are indistinguishable (401), so ids can't be probed.
 */
@Injectable()
export class ConversationAccessGuard implements CanActivate {
  constructor(private readonly store: PgAgentStore) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const principal = principalOf(req);
    if (isReviewerPrincipal(principal)) {
      if (!csrfOk(req, principal)) throw new ForbiddenException('Missing X-Requested-By header');
      return true;
    }
    const token = req.headers[CONVERSATION_TOKEN_HEADER];
    const id = req.params.id;
    if (typeof token === 'string' && typeof id === 'string' && isUUID(id) && (await this.store.verifyConversationToken(id, token))) return true;
    throw new UnauthorizedException('A valid conversation token or reviewer credentials are required');
  }
}
