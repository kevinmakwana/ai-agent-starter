import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { AppConfig } from '../config';
import { PgAgentStore } from '../db/pg-agent.store';
import { APP_CONFIG } from '../tokens';
import { isReviewer } from './reviewer.guard';

export const CONVERSATION_TOKEN_HEADER = 'x-conversation-token';

/**
 * A conversation is readable/writable by whoever holds its access token (returned once, on creation),
 * or by a reviewer. Unknown ids and wrong tokens are indistinguishable (401), so ids can't be probed.
 */
@Injectable()
export class ConversationAccessGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig, private readonly store: PgAgentStore) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (isReviewer(this.cfg.reviewerApiKey, req.headers.authorization)) return true;
    const token = req.headers[CONVERSATION_TOKEN_HEADER];
    const id = req.params.id;
    if (typeof token === 'string' && typeof id === 'string' && (await this.store.verifyConversationToken(id, token))) return true;
    throw new UnauthorizedException('A valid conversation token or reviewer credentials are required');
  }
}
