import { Inject, Injectable, Logger, type OnApplicationShutdown, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../tokens';
import { CUSTOMER_COOKIE, readCookie } from './cookie';
import {
  KEEP_UNUSED_LINKS, LINK_TTL_MINUTES, LINKS_PER_HOUR, type CustomerAuthStore, type CustomerIdentity,
} from './customer.store';
import type { LoginMailer } from './login-mailer';
import { hashToken, newToken } from './session-token';
import { CUSTOMER_AUTH_STORE, LOGIN_MAILER } from './tokens';

const invalidLink = () => new UnauthorizedException('Invalid or expired link');

/** Longer than any real token: refuse before hashing so a huge body costs nothing. */
const MAX_TOKEN = 512;

/** Only a short upper-case code (`EAUTH`) may reach a log: other error text can carry an address or the link. */
const reason = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'error';
};

@Injectable()
export class CustomerAuthService implements OnApplicationShutdown {
  private readonly log = new Logger('CustomerAuth');
  private readonly pending = new Set<Promise<void>>();

  constructor(
    @Inject(CUSTOMER_AUTH_STORE) private readonly store: CustomerAuthStore,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(LOGIN_MAILER) private readonly mailer: LoginMailer | null,
  ) {}

  get enabled(): boolean {
    return this.cfg.customerLogin.enabled;
  }

  /**
   * Resolves after one lookup whether or not the email is a customer's. Creating the link and sending the mail run
   * afterwards, so neither a slow mail server nor the extra writes can tell a known email from an unknown one.
   */
  async requestLink(email: string): Promise<void> {
    const customer = await this.store.findCustomerByEmail(email.trim());
    if (!customer || !this.mailer) return;
    const job = this.deliver(customer, this.mailer).catch((e) => this.log.warn(`Could not send a sign-in link (${reason(e)})`));
    this.pending.add(job);
    void job.then(() => this.pending.delete(job));
  }

  private async deliver(customer: CustomerIdentity, mailer: LoginMailer): Promise<void> {
    const token = newToken();
    const created = await this.store.createLoginLink(customer.id, hashToken(token), LINK_TTL_MINUTES, {
      maxPerHour: LINKS_PER_HOUR, keepUnused: KEEP_UNUSED_LINKS,
    });
    if (!created) return;
    await mailer.sendLink(customer.email, `${this.cfg.customerLogin.appUrl}/login#token=${token}`, LINK_TTL_MINUTES);
  }

  /** Waits for in-flight deliveries (tests, shutdown). Never rejects: failures were already logged. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.drain();
    this.mailer?.close();
  }

  /** One failure for every cause: unknown, used, expired, superseded, malformed. */
  async verify(linkToken: string): Promise<{ token: string; customer: CustomerIdentity }> {
    if (typeof linkToken !== 'string' || linkToken.length === 0 || linkToken.length > MAX_TOKEN) throw invalidLink();
    const customer = await this.store.consumeLoginLink(hashToken(linkToken));
    if (!customer) throw invalidLink();
    const token = newToken();
    await this.store.createSession(customer.id, hashToken(token), this.cfg.customerLogin.sessionTtlDays);
    await this.store.deleteExpired().catch(() => undefined); // housekeeping must never fail a sign-in
    return { token, customer };
  }

  async resolve(req: Pick<Request, 'headers'>): Promise<CustomerIdentity | null> {
    const token = readCookie(req, CUSTOMER_COOKIE);
    return token ? this.store.resolveSession(hashToken(token)) : null;
  }

  logout(token: string): Promise<void> {
    return this.store.deleteSession(hashToken(token));
  }

  logoutAll(customerId: number): Promise<void> {
    return this.store.deleteSessionsForCustomer(customerId);
  }
}
