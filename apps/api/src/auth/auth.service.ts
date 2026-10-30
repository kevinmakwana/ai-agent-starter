import { BadRequestException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import type { AppConfig } from '../config';
import { isReviewer } from '../http/reviewer.guard';
import { APP_CONFIG } from '../tokens';
import { readCookie, SESSION_COOKIE } from './cookie';
import * as password from './password';
import { NONE, type Principal } from './principal';
import type { Reviewer, ReviewerStore } from './reviewer.store';
import { REVIEWER_STORE } from './tokens';

/** Only this hash is stored, so a copy of the database cannot be replayed as a cookie. */
export const hashSessionToken = (token: string) => createHash('sha256').update(token).digest('hex');

const invalidLogin = () => new UnauthorizedException('Invalid email or password');

@Injectable()
export class AuthService {
  private readonly log = new Logger('Auth');
  private warnedDemo = false;
  private warnedKeyIgnored = false;

  constructor(@Inject(REVIEWER_STORE) private readonly store: ReviewerStore, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** True once any reviewer exists. The store caches the answer briefly. */
  isAccountsMode() {
    return this.store.hasAnyReviewer();
  }

  /** Who is calling: the session cookie once accounts exist, else the shared key, else (no key at all) the open demo. */
  async resolvePrincipal(req: Pick<Request, 'headers'>): Promise<Principal> {
    try {
      if (!(await this.isAccountsMode())) {
        if (!this.cfg.reviewerApiKey) {
          if (!this.warnedDemo) {
            this.warnedDemo = true;
            this.log.warn('No reviewer accounts and REVIEWER_API_KEY is not set: reviewer routes and all conversations are open (demo mode).');
          }
          return { kind: 'demo' };
        }
        return isReviewer(this.cfg.reviewerApiKey, req.headers.authorization) ? { kind: 'key' } : NONE;
      }
      if (this.cfg.reviewerApiKey && !this.warnedKeyIgnored) {
        this.warnedKeyIgnored = true;
        this.log.warn('Reviewer accounts exist: REVIEWER_API_KEY is ignored. Reviewers must sign in.');
      }
      const token = readCookie(req, SESSION_COOKIE);
      if (!token) return NONE;
      const reviewer = await this.store.resolveSession(hashSessionToken(token));
      return reviewer ? { kind: 'reviewer', ...reviewer } : NONE;
    } catch (e) {
      // Fail closed: if the database cannot answer, nobody is a reviewer.
      this.log.error(`Could not resolve the caller: ${e instanceof Error ? e.message : e}`);
      return NONE;
    }
  }

  /** One failure for every cause (unknown, wrong password, inactive, locked), with the same amount of hashing work. */
  async login(email: string, plain: string): Promise<{ token: string; reviewer: Reviewer }> {
    const found = await this.store.findByEmail(email.trim());
    if (!found) {
      await password.dummyVerify(plain);
      throw invalidLogin();
    }
    if (!found.active || found.locked) {
      await password.dummyVerify(plain);
      throw invalidLogin();
    }
    if (!(await password.verifyPassword(plain, found.passwordHash))) {
      await this.store.recordLoginFailure(found.id);
      throw invalidLogin();
    }
    await this.store.recordLoginSuccess(found.id);
    const token = randomBytes(32).toString('base64url');
    await this.store.createSession(found.id, hashSessionToken(token), this.cfg.auth.sessionTtlHours);
    await this.store.deleteExpired().catch(() => undefined); // housekeeping must never fail a login
    // an explicit list, so nothing the store happens to return (hash, counters) can reach a response
    const { id, name, role, active, createdAt } = found;
    return { token, reviewer: { id, email: found.email, name, role, active, createdAt, lastLoginAt: new Date().toISOString() } };
  }

  logout(token: string) {
    return this.store.deleteSession(hashSessionToken(token));
  }

  /** Verifies the current password (a wrong guess counts toward the lockout), then ends every other session. */
  async changePassword(reviewerId: string, current: string, next: string, keepToken: string): Promise<void> {
    const me = await this.store.findById(reviewerId);
    const creds = me && (await this.store.findByEmail(me.email));
    if (!creds || !(await password.verifyPassword(current, creds.passwordHash))) {
      if (creds) await this.store.recordLoginFailure(creds.id);
      else await password.dummyVerify(current);
      throw new BadRequestException('Current password is incorrect');
    }
    let passwordHash: string;
    try {
      passwordHash = await password.hashPassword(next);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'Invalid password');
    }
    await this.store.updateReviewer(reviewerId, { passwordHash }, { keepSession: hashSessionToken(keepToken) });
  }
}
