import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import { csrfOk } from '../auth/csrf';
import { customerOf, isReviewerPrincipal, principalOf } from '../auth/principal';
import type { AppConfig } from '../config';
import { PgAgentStore } from '../db/pg-agent.store';
import { APP_CONFIG } from '../tokens';

export const CONVERSATION_TOKEN_HEADER = 'x-conversation-token';

const LOGIN_DENIED = 'Sign in to access this conversation';

/**
 * Login off: a conversation is readable/writable by whoever holds its access token (returned once, on creation),
 * or by a reviewer. Login on: by its own signed-in customer or a reviewer; tokens are not consulted, and the open
 * demo is no way past the login. Unknown ids and wrong customers/tokens are indistinguishable (401), so ids can't be probed.
 */
@Injectable()
export class ConversationAccessGuard implements CanActivate {
  constructor(private readonly store: PgAgentStore, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const principal = principalOf(req);
    const id = req.params.id;
    const login = this.cfg.customerLogin.enabled;

    const customer = customerOf(principal);
    if (customer) {
      if (!csrfOk(req, principal)) throw new ForbiddenException('Missing X-Requested-By header');
      if (typeof id === 'string' && isUUID(id) && (await this.store.conversationBelongsToCustomer(id, customer.customerId))) return true;
      throw new UnauthorizedException(LOGIN_DENIED); // wrong customer and unknown id look the same
    }
    // In login mode the open demo is not a way past the login: only a real reviewer (cookie or key) gets in.
    if (isReviewerPrincipal(principal) && !(login && principal.kind === 'demo')) {
      if (!csrfOk(req, principal)) throw new ForbiddenException('Missing X-Requested-By header');
      return true;
    }
    if (login) throw new UnauthorizedException(LOGIN_DENIED); // conversation tokens are not consulted
    const token = req.headers[CONVERSATION_TOKEN_HEADER];
    if (typeof token === 'string' && typeof id === 'string' && isUUID(id) && (await this.store.verifyConversationToken(id, token))) return true;
    throw new UnauthorizedException('A valid conversation token or reviewer credentials are required');
  }
}
