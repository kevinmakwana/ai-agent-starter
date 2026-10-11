import { type CanActivate, type ExecutionContext, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../tokens';

/** True when no reviewer key is configured (open demo mode) or the request carries the right one. */
export function isReviewer(reviewerApiKey: string, authorization: string | undefined): boolean {
  if (!reviewerApiKey) return true;
  const header = authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(reviewerApiKey);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Shared-secret gate for reviewer/operator routes. With REVIEWER_API_KEY unset the API stays open
 * so the zero-config demo works; set it and these routes require `Authorization: Bearer <key>`.
 */
@Injectable()
export class ReviewerGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    if (!cfg.reviewerApiKey) {
      new Logger('Auth').warn('REVIEWER_API_KEY is not set: reviewer routes and all conversations are open (demo mode).');
    }
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (!isReviewer(this.cfg.reviewerApiKey, ctx.switchToHttp().getRequest<Request>().headers.authorization)) {
      throw new UnauthorizedException('Reviewer credentials required');
    }
    return true;
  }
}
