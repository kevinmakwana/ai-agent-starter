import { type CanActivate, type ExecutionContext, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../tokens';

/**
 * Shared-secret gate for reviewer/operator routes. With REVIEWER_API_KEY unset the API stays open
 * so the zero-config demo works; set it and these routes require `Authorization: Bearer <key>`.
 */
@Injectable()
export class ReviewerGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    if (!cfg.reviewerApiKey) {
      new Logger('Auth').warn('REVIEWER_API_KEY is not set: /approvals and /customers are unauthenticated (demo mode).');
    }
  }

  canActivate(ctx: ExecutionContext): boolean {
    const expected = this.cfg.reviewerApiKey;
    if (!expected) return true;
    const header = ctx.switchToHttp().getRequest<Request>().headers.authorization ?? '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new UnauthorizedException('Reviewer credentials required');
    }
    return true;
  }
}
