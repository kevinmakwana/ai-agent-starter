import type { CookieOptions, Request } from 'express';
import type { AppConfig } from '../config';

export const SESSION_COOKIE = 'reviewer_session';
export const CUSTOMER_COOKIE = 'customer_session';

/** Reads one cookie from the `Cookie` header (the first of that name); undefined when absent or undecodable. */
export function readCookie(req: Pick<Request, 'headers'>, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const cookie = (secure: boolean, maxAgeMs: number): CookieOptions => ({ httpOnly: true, sameSite: 'strict', path: '/', secure, maxAge: maxAgeMs });

export const sessionCookieOptions = (auth: AppConfig['auth']): CookieOptions => cookie(auth.cookieSecure, auth.sessionTtlHours * 3_600_000);

export const customerCookieOptions = (cfg: Pick<AppConfig, 'auth' | 'customerLogin'>): CookieOptions =>
  cookie(cfg.auth.cookieSecure, cfg.customerLogin.sessionTtlDays * 86_400_000);
