# Customer Login by Email Magic Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `CUSTOMER_LOGIN=true`, customers sign in with a one-time emailed link, and a conversation can be started, read, written to or streamed only by the customer it is bound to (or a reviewer); with it off, everything behaves exactly as today.

**Architecture:** Two new tables (`login_links`, `customer_sessions`) behind a `CustomerAuthStore`; a `CustomerAuthService` that issues links (mail sent after the response), consumes them atomically and resolves a `customer_session` cookie; a new `customer` principal produced by `PrincipalMiddleware` only in login mode and **explicitly not a reviewer**; `ConversationAccessGuard` and `POST /conversations` follow the session instead of tokens in login mode; a small `/customer-auth` controller; the customer web page gains a sign-in form, a `/login` landing page and a "my conversations" list.

**Tech Stack:** NestJS 11, raw `pg`, `nodemailer` (already a dependency), Jest 30, Next.js 16 + React 19, `node:test` for web.

**Spec:** `docs/superpowers/specs/2026-10-31-customer-login-design.md` (the binding authority; read it fully before starting). It builds on `docs/superpowers/specs/2026-10-29-reviewer-accounts-four-eyes-design.md` (principal pipeline, CSRF header, session pattern) which is already implemented on this branch.

## Global Constraints

- Branch `phase-4-accounts`. Never push or merge.
- e2e tests run ONLY against `E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5435/aiagent_test` (container `ai-agent-starter-db-1`; it re-seeds). Never touch other ports or other projects' containers. Jest runs `maxWorkers: 1`. Each shell call is fresh: `export E2E_DATABASE_URL=...` in every command that runs e2e.
- e2e suite hygiene (each of these bit during 4.5a): close every app you boot (if a `beforeEach` already booted one, `await app.close()` before booting another inside the test); end every e2e file with an `afterAll` that reseeds through a plain `createPool(...)` + `seedDatabase` + `pool.end()` (never boot an app in `afterAll`: it leaks a LISTEN connection and breaks later suites); restore every `process.env` key you set; leave the database seeded with no reviewers.
- macOS: there is no `timeout` command; use `sed -i ''`; run a single Jest file with `npm test -w apps/api -- <pattern>`.
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- With `CUSTOMER_LOGIN` unset or `false`, demo, key and conversation-token behaviour is exactly as today; every existing test passes unchanged except where this plan names a change (the `/health` assertion in `approval-flow.e2e-spec.ts`).
- Secrets: no login token, session token, token hash or customer email-in-error ever appears in a response, a log line, an error message or a test snapshot. Mail failures are logged without the address or the link.
- Tokens: 32 random bytes, base64url; the database stores only the SHA-256 hex. Link: 15 minutes, single use, at most 5 created per customer per rolling hour (beyond that nothing is sent), all but the 2 newest unused links of a customer are expired when a new one is created.
- Session: cookie `customer_session`, `HttpOnly; SameSite=Strict; Path=/`, `Secure` under the existing `COOKIE_SECURE` rule, `CUSTOMER_SESSION_TTL_DAYS` (default 7) absolute, 24 hours idle, `last_seen_at` refreshed at most once a minute, a new token at every login.
- CSRF: both unauthenticated `/customer-auth` POSTs and every cookie-authenticated customer mutation need header `X-Requested-By: reviewer-console` (403 otherwise). The web `call()` helper already sends it on every non-GET.
- In login mode every failed conversation access answers the same `401` with the same body (wrong customer, unknown id, anonymous, demo).
- Every failed link verification (unknown, used, expired, superseded, malformed, empty) is `401 Invalid or expired link`.
- Match surrounding style (comment density, naming, small focused files). Use the Context7 MCP tools for any NestJS/Express/Next.js API you are unsure about and say which version the docs were for. Before web work read `node_modules/next/dist/docs/` as `apps/web/AGENTS.md` demands; do not run `next upgrade`.

## Review Focus

- A `customer` principal reaching anything reviewer-only: `ReviewerGuard`, `AdminGuard`, `approvalForCaller`, `forCaller`, the conversation trace/send views, `/events`, `/customers`, `/approvals`, `/reviewers`. Expected: `401`, and the customer view of a conversation has no `policyRule`, `policyDetail`, `notifiedAt`, `approvalsRequired`, `approvalsGiven`, `approvedBy`, `approvedByIds`. (Task 3)
- One link used twice, used by 8 requests at the same instant, or superseded by a newer link: exactly one session, never two. (Tasks 2 and 4)
- Login on while the reviewer side is the open demo (no reviewers, no key): an anonymous caller must get `401` on conversations, while a signed-in customer still works there. (Task 3)
- Mail trouble after the response: an SMTP error or a slow server must not change the `202`, crash the process with an unhandled rejection, leak the address or link into a log, or be lost on shutdown mid-send. (Tasks 2 and 3)
- Upgrade and mode edges: conversations created before login mode (with a token) show up for their customer after sign-in but their token no longer works; `POST /conversations {}` is still `400` with login off; with login on a body `customerId`/`email` is `400`; email matching ignores case and surrounding whitespace. (Tasks 3 and 4)

---

### Task 1: Configuration, schema and the mail sender

**Files:**
- Modify: `apps/api/src/notify/notify-config.ts` (export four helpers), `apps/api/src/notify/email.channel.ts` (extract the transport), `apps/api/src/config.ts` (+ `config.spec.ts`), `apps/api/src/db/schema.ts`, `.env.example`
- Create: `apps/api/src/auth/login-mailer.ts`, `apps/api/src/auth/login-mailer.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  // config.ts
  export interface CustomerLoginConfig {
    enabled: boolean;
    appUrl: string;            // no trailing slash
    sessionTtlDays: number;
    requestPerMinute: number;  // validated here; the route reads the env per request via loadCustomerLoginLimit
    mail?: { smtpUrl: string; from: string };
  }
  export const loadCustomerLoginLimit: (env?: NodeJS.ProcessEnv) => number;
  // AppConfig gains: customerLogin: CustomerLoginConfig
  // email.channel.ts
  export function createSmtpTransport(smtpUrl: string): nodemailer.Transporter;
  // login-mailer.ts
  export interface LoginMailer { sendLink(to: string, link: string, ttlMinutes: number): Promise<void>; close(): void }
  export function createLoginMailer(opts: { smtpUrl: string; from: string; transport?: nodemailer.Transporter }): LoginMailer;
  ```

- [ ] **Step 1: Failing config tests.** Append to `apps/api/src/config.spec.ts`:

```ts
describe('customer login config', () => {
  const mail = { LOGIN_SMTP_URL: 'smtp://u:p@smtp.example.com:587', LOGIN_EMAIL_FROM: 'support@example.com' };

  it('is off by default and needs nothing', () => {
    expect(loadConfig({}).customerLogin).toEqual({
      enabled: false, appUrl: 'http://localhost:3000', sessionTtlDays: 7, requestPerMinute: 5,
    });
  });

  it('turns on only with true, and needs the mail settings', () => {
    expect(loadConfig({ CUSTOMER_LOGIN: 'true', ...mail }).customerLogin).toMatchObject({
      enabled: true, mail: { smtpUrl: mail.LOGIN_SMTP_URL, from: 'support@example.com' },
    });
    expect(() => loadConfig({ CUSTOMER_LOGIN: 'true' })).toThrow('LOGIN_SMTP_URL');
    expect(() => loadConfig({ CUSTOMER_LOGIN: 'true', LOGIN_SMTP_URL: mail.LOGIN_SMTP_URL })).toThrow('together');
    expect(() => loadConfig({ CUSTOMER_LOGIN: 'yes', ...mail })).toThrow('CUSTOMER_LOGIN');
  });

  it('refuses half a mail setup even when login is off, and validates the values without echoing them', () => {
    expect(() => loadConfig({ LOGIN_EMAIL_FROM: 'support@example.com' })).toThrow('together');
    expect(() => loadConfig({ LOGIN_SMTP_URL: 'http://smtp.example.com', LOGIN_EMAIL_FROM: 'a@example.com' })).toThrow('LOGIN_SMTP_URL');
    let message = '';
    try { loadConfig({ LOGIN_SMTP_URL: 'ftp://user:secretpw@host', LOGIN_EMAIL_FROM: 'a@example.com' }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('LOGIN_SMTP_URL');
    expect(message).not.toContain('secretpw');
    expect(() => loadConfig({ LOGIN_SMTP_URL: mail.LOGIN_SMTP_URL, LOGIN_EMAIL_FROM: 'not an address' })).toThrow('LOGIN_EMAIL_FROM');
  });

  it('trims the app url, validates numbers', () => {
    expect(loadConfig({ CUSTOMER_APP_URL: 'https://shop.example.com/' }).customerLogin.appUrl).toBe('https://shop.example.com');
    expect(() => loadConfig({ CUSTOMER_APP_URL: 'javascript:alert(1)' })).toThrow('CUSTOMER_APP_URL');
    expect(loadConfig({ CUSTOMER_SESSION_TTL_DAYS: '30', RATE_LIMIT_CUSTOMER_LOGIN_PER_MINUTE: '2' }).customerLogin)
      .toMatchObject({ sessionTtlDays: 30, requestPerMinute: 2 });
    expect(() => loadConfig({ CUSTOMER_SESSION_TTL_DAYS: '0' })).toThrow('CUSTOMER_SESSION_TTL_DAYS');
    expect(() => loadConfig({ RATE_LIMIT_CUSTOMER_LOGIN_PER_MINUTE: 'x' })).toThrow('RATE_LIMIT_CUSTOMER_LOGIN_PER_MINUTE');
  });
});
```

- [ ] **Step 2: Failing mailer tests.** Create `apps/api/src/auth/login-mailer.spec.ts`:

```ts
import * as nodemailer from 'nodemailer';
import { createLoginMailer } from './login-mailer';

const link = 'http://localhost:3000/login#token=abcDEF123_-xyz';
const options = { smtpUrl: 'smtp://u:p@smtp.example.com:587', from: 'support@example.com' };
const jsonTransport = () => nodemailer.createTransport({ jsonTransport: true });

describe('createLoginMailer', () => {
  it('sends one plain-text mail with the link and how long it lasts, and nothing else about the customer', async () => {
    const transport = jsonTransport();
    const send = jest.spyOn(transport, 'sendMail');
    await createLoginMailer({ ...options, transport }).sendLink('ava@example.com', link, 15);
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0] as { from: string; to: string; subject: string; text: string; html?: string };
    expect(mail).toMatchObject({ from: 'support@example.com', to: 'ava@example.com', subject: 'Your sign-in link' });
    expect(mail.text).toContain(link);
    expect(mail.text).toContain('15 minutes');
    expect(mail.html).toBeUndefined();
    expect(mail.text).not.toMatch(/ava|order|conversation/i);
  });

  it('reports only a short error code, never the server text, the address or the link', async () => {
    const transport = jsonTransport();
    jest.spyOn(transport, 'sendMail').mockRejectedValue(Object.assign(new Error('535 auth failed for ava@example.com via smtp://u:p@host'), { code: 'EAUTH' }));
    const err = await createLoginMailer({ ...options, transport }).sendLink('ava@example.com', link, 15).catch((e) => e);
    expect(err.message).toBe('login email failed (EAUTH)');
    jest.spyOn(transport, 'sendMail').mockRejectedValue(new Error('boom with ava@example.com'));
    const plain = await createLoginMailer({ ...options, transport }).sendLink('ava@example.com', link, 15).catch((e) => e);
    expect(plain.message).toBe('login email failed');
  });

  it('closes the transport', () => {
    const transport = jsonTransport();
    const close = jest.spyOn(transport, 'close');
    createLoginMailer({ ...options, transport }).close();
    expect(close).toHaveBeenCalled();
  });

  it('builds the same hardened transport as the notification email channel when none is given', () => {
    const spy = jest.spyOn(nodemailer, 'createTransport');
    try {
      createLoginMailer(options);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        url: options.smtpUrl, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 5000, requireTLS: true,
      }));
      const built = spy.mock.calls[0][0] as Record<string, unknown>;
      expect(built.logger).toBeUndefined();
      expect(built.debug).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
```

- [ ] **Step 3: Run to see them fail.** `export E2E_DATABASE_URL=...; npm test -w apps/api -- src/config.spec.ts src/auth/login-mailer`. Expected: config tests fail (`customerLogin` undefined), mailer suite fails to compile (`./login-mailer` missing).

- [ ] **Step 4: Implement.**

`apps/api/src/notify/notify-config.ts`: add `export` to the four existing helpers `optional`, `httpUrl`, `smtpUrl`, `address` (no other change).

`apps/api/src/notify/email.channel.ts`: extract the transport so the login mailer reuses it. Replace the inline `nodemailer.createTransport({...})` block with:

```ts
/** One place for the hardened SMTP transport: 5 s timeouts, STARTTLS required for remote plaintext-start hosts, no logging. */
export function createSmtpTransport(smtpUrl: string): nodemailer.Transporter {
  return nodemailer.createTransport({
    url: smtpUrl,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
    dnsTimeout: TIMEOUT_MS,
    ...(needsStartTls(smtpUrl) ? { requireTLS: true } : {}),
  });
}
```
and in `emailChannel`: `const transporter = transport ?? createSmtpTransport(smtpUrl);`. The existing `email.channel.spec.ts` must pass unchanged.

`apps/api/src/auth/login-mailer.ts`:

```ts
import type * as nodemailer from 'nodemailer';
import { createSmtpTransport } from '../notify/email.channel';

export interface LoginMailer {
  sendLink(to: string, link: string, ttlMinutes: number): Promise<void>;
  close(): void;
}

/** Only a short upper-case token such as `EAUTH` is reported: server text can echo the address or credentials. */
const CODE = /^[A-Z0-9_]{1,32}$/;

/** The sign-in mail: plain text, the link and its lifetime, no customer data. Failures carry at most an error code. */
export function createLoginMailer({ smtpUrl, from, transport }: { smtpUrl: string; from: string; transport?: nodemailer.Transporter }): LoginMailer {
  const transporter = transport ?? createSmtpTransport(smtpUrl);
  return {
    async sendLink(to, link, ttlMinutes) {
      const text = [
        `Use this link to sign in to Acme Shop support. It works once and expires in ${ttlMinutes} minutes:`,
        '',
        link,
        '',
        'If you did not ask for it, you can ignore this email.',
      ].join('\n');
      try {
        await transporter.sendMail({ from, to, subject: 'Your sign-in link', text });
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        throw new Error(typeof code === 'string' && CODE.test(code) ? `login email failed (${code})` : 'login email failed');
      }
    },
    close() {
      transporter.close();
    },
  };
}
```

`apps/api/src/config.ts`: extend the import to `import { address, httpUrl, loadNotifyConfig, optional, smtpUrl as validSmtpUrl, type NotifyConfig } from './notify/notify-config';`, then add (near `AuthConfig`):

```ts
export interface CustomerLoginConfig {
  /** CUSTOMER_LOGIN=true: customers sign in by emailed link and conversations follow the session, not a token. */
  enabled: boolean;
  /** Where the emailed link points (the customer web app), without a trailing slash. */
  appUrl: string;
  /** Absolute lifetime of a customer session, in days. */
  sessionTtlDays: number;
  /** POST /customer-auth/request and /verify per client per minute (the routes re-read the env per request). */
  requestPerMinute: number;
  /** Where link mail goes through; present when LOGIN_SMTP_URL and LOGIN_EMAIL_FROM are set. */
  mail?: { smtpUrl: string; from: string };
}

/** Read on its own like the other limits, because route decorators resolve it per request. */
export const loadCustomerLoginLimit = (env: NodeJS.ProcessEnv = process.env): number => positiveInt(env, 'RATE_LIMIT_CUSTOMER_LOGIN_PER_MINUTE', 5);

function loadCustomerLogin(env: NodeJS.ProcessEnv): CustomerLoginConfig {
  const enabled = booleanFlag(env, 'CUSTOMER_LOGIN', false);
  const smtp = optional(env, 'LOGIN_SMTP_URL');
  const from = optional(env, 'LOGIN_EMAIL_FROM');
  if ((smtp || from) && !(smtp && from)) throw new Error('LOGIN_SMTP_URL and LOGIN_EMAIL_FROM must be set together');
  if (enabled && !(smtp && from)) throw new Error('CUSTOMER_LOGIN=true requires LOGIN_SMTP_URL and LOGIN_EMAIL_FROM');
  return {
    enabled,
    appUrl: httpUrl('CUSTOMER_APP_URL', optional(env, 'CUSTOMER_APP_URL') ?? 'http://localhost:3000').replace(/\/+$/, ''),
    sessionTtlDays: positiveInt(env, 'CUSTOMER_SESSION_TTL_DAYS', 7),
    requestPerMinute: loadCustomerLoginLimit(env),
    ...(smtp && from ? { mail: { smtpUrl: validSmtpUrl('LOGIN_SMTP_URL', smtp), from: address('LOGIN_EMAIL_FROM', from) } } : {}),
  };
}
```
Add `customerLogin: CustomerLoginConfig;` to `AppConfig` (after `auth`) and `customerLogin: loadCustomerLogin(env),` in `loadConfig` (after `auth`). Because `booleanFlag` and `positiveInt` are declared above `AuthConfig`, place the new block after them.

`apps/api/src/db/schema.ts`: add before the `ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_action_id` line:

```sql
-- Customer login (TODO 4.5b). Links and sessions store only a SHA-256 of the token.
CREATE TABLE IF NOT EXISTS login_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id int NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS login_links_customer_idx ON login_links (customer_id, created_at);
CREATE TABLE IF NOT EXISTS customer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id int NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS customer_sessions_customer_idx ON customer_sessions (customer_id);
```
and append `, login_links, customer_sessions` to the `RESET_SQL` table list (before `RESTART IDENTITY CASCADE`).

`.env.example`: after the `RATE_LIMIT_LOGIN_PER_MINUTE` block add, in the same commented style:

```
# Customer login (off by default). When on, customers sign in with a one-time emailed link and a conversation can only
# be used by the customer it belongs to. Needs a mail server below. Does not apply to reviewers.
# CUSTOMER_LOGIN=false
# LOGIN_SMTP_URL=smtp://user:pass@smtp.example.com:587
# LOGIN_EMAIL_FROM=support@example.com
# Where the emailed link points (the customer web app), and how long a customer session lasts.
# CUSTOMER_APP_URL=http://localhost:3000
# CUSTOMER_SESSION_TTL_DAYS=7
# POST /customer-auth/request and /verify per client per minute.
# RATE_LIMIT_CUSTOMER_LOGIN_PER_MINUTE=5
```

- [ ] **Step 5: Run.** `npm test -w apps/api -- src/config.spec.ts src/auth/login-mailer src/notify` then root `npm run typecheck`, then the whole API suite with `E2E_DATABASE_URL` (proves the new DDL applies on top of an existing database and nothing else moved). Expected: all pass.
- [ ] **Step 6: Commit** `Add customer login settings, the login tables and the sign-in mail sender`. Test command for the ledger: `npm test -w apps/api`.

---

### Task 2: Link and session store, and the customer auth service

**Files:**
- Create: `apps/api/src/auth/session-token.ts`, `apps/api/src/auth/customer.store.ts`, `apps/api/src/auth/pg-customer.store.ts`, `apps/api/src/auth/customer-auth.service.ts`, `apps/api/src/auth/customer-auth.service.spec.ts`, `apps/api/test/fake-customers.ts`, `apps/api/test/customer-auth-store.e2e-spec.ts`
- Modify: `apps/api/src/auth/tokens.ts`, `apps/api/src/auth/auth.service.ts` (use the shared token helpers), `apps/api/src/auth/cookie.ts` (+ `cookie.spec.ts`)

**Interfaces:**
- Consumes: `LoginMailer`, `AppConfig.customerLogin` (Task 1); `APP_CONFIG` token.
- Produces:
  ```ts
  // session-token.ts
  export const newToken: () => string;                 // 32 random bytes, base64url
  export const hashToken: (token: string) => string;   // SHA-256 hex
  // cookie.ts (additions)
  export const CUSTOMER_COOKIE = 'customer_session';
  export function customerCookieOptions(cfg: Pick<AppConfig, 'auth' | 'customerLogin'>): CookieOptions;
  // tokens.ts (additions)
  export const CUSTOMER_AUTH_STORE: unique symbol;  export const LOGIN_MAILER: unique symbol;
  // customer.store.ts
  export const LINK_TTL_MINUTES = 15, LINKS_PER_HOUR = 5, KEEP_UNUSED_LINKS = 2, CUSTOMER_IDLE_HOURS = 24;
  export interface CustomerIdentity { id: number; name: string; email: string }
  export interface CustomerAuthStore {
    findCustomerByEmail(email: string): Promise<CustomerIdentity | null>;                // case-insensitive
    createLoginLink(customerId: number, tokenHash: string, ttlMinutes: number,
                    limits: { maxPerHour: number; keepUnused: number }): Promise<boolean>; // false = over the hourly limit, nothing created
    consumeLoginLink(tokenHash: string): Promise<CustomerIdentity | null>;             // atomic, single use
    createSession(customerId: number, tokenHash: string, ttlDays: number): Promise<void>;
    resolveSession(tokenHash: string): Promise<CustomerIdentity | null>;
    deleteSession(tokenHash: string): Promise<void>;
    deleteSessionsForCustomer(customerId: number): Promise<void>;
    deleteExpired(): Promise<void>;
  }
  // pg-customer.store.ts:   export class PgCustomerAuthStore implements CustomerAuthStore { constructor(pool: Pool) }
  // customer-auth.service.ts
  @Injectable() export class CustomerAuthService implements OnApplicationShutdown {
    constructor(store: CustomerAuthStore /*CUSTOMER_AUTH_STORE*/, cfg: AppConfig /*APP_CONFIG*/, mailer: LoginMailer | null /*LOGIN_MAILER*/);
    get enabled(): boolean;
    requestLink(email: string): Promise<void>;                       // resolves after ONE lookup; link + mail run afterwards
    drain(): Promise<void>;                                           // waits for in-flight deliveries (tests, shutdown)
    verify(token: string): Promise<{ token: string; customer: CustomerIdentity }>; // throws UnauthorizedException('Invalid or expired link')
    resolve(req: Pick<Request, 'headers'>): Promise<CustomerIdentity | null>;      // from the customer_session cookie
    logout(token: string): Promise<void>;
    logoutAll(customerId: number): Promise<void>;
  }
  // test/fake-customers.ts: export class MemoryCustomerAuthStore implements CustomerAuthStore  (injectable `now`)
  ```

- [ ] **Step 1: Shared token helpers (refactor, no behaviour change).** Create `apps/api/src/auth/session-token.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes, base64url: a session cookie value or a login-link token. */
export const newToken = (): string => randomBytes(32).toString('base64url');

/** Only this hash is stored, so a copy of the database cannot be replayed as a cookie or a link. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
```
In `auth.service.ts` replace its local `createHash`/`randomBytes` use: `export const hashSessionToken = hashToken;` (keep the export name, other files import it), and `const token = newToken();` in `login`. In `cookie.ts` refactor so both cookies share one builder:

```ts
export const CUSTOMER_COOKIE = 'customer_session';

const cookie = (secure: boolean, maxAgeMs: number): CookieOptions => ({ httpOnly: true, sameSite: 'strict', path: '/', secure, maxAge: maxAgeMs });

export const sessionCookieOptions = (auth: AppConfig['auth']): CookieOptions => cookie(auth.cookieSecure, auth.sessionTtlHours * 3_600_000);

export const customerCookieOptions = (cfg: Pick<AppConfig, 'auth' | 'customerLogin'>): CookieOptions =>
  cookie(cfg.auth.cookieSecure, cfg.customerLogin.sessionTtlDays * 86_400_000);
```
Add to `tokens.ts`: `export const CUSTOMER_AUTH_STORE = Symbol('CUSTOMER_AUTH_STORE'); export const LOGIN_MAILER = Symbol('LOGIN_MAILER');`. Run `npm test -w apps/api -- src/auth` (the existing specs must still pass), then append to `cookie.spec.ts`:

```ts
describe('customerCookieOptions', () => {
  it('is HttpOnly, SameSite=Strict, site-wide, as long as the customer session, Secure on request', () => {
    const cfg = loadConfig({ CUSTOMER_SESSION_TTL_DAYS: '3', COOKIE_SECURE: 'true' });
    expect(customerCookieOptions(cfg)).toEqual({ httpOnly: true, sameSite: 'strict', path: '/', secure: true, maxAge: 3 * 86_400_000 });
    expect(CUSTOMER_COOKIE).toBe('customer_session');
    expect(customerCookieOptions(loadConfig({})).secure).toBe(false);
  });
});
```
(import `customerCookieOptions, CUSTOMER_COOKIE` at the top). Commit nothing yet.

- [ ] **Step 2: Store contract and the in-memory fake.** Create `apps/api/src/auth/customer.store.ts` with the constants and interfaces listed under Interfaces (no other code). Create `apps/api/test/fake-customers.ts`:

```ts
import {
  CUSTOMER_IDLE_HOURS, type CustomerAuthStore, type CustomerIdentity,
} from '../src/auth/customer.store';

interface Link { customerId: number; hash: string; createdAt: number; expiresAt: number; usedAt: number | null }
interface Session { customerId: number; createdAt: number; lastSeenAt: number; expiresAt: number }

/** In-memory CustomerAuthStore for unit tests; `now` is injectable so expiry needs no sleeping. */
export class MemoryCustomerAuthStore implements CustomerAuthStore {
  links: Link[] = [];
  sessions = new Map<string, Session>();
  now = () => Date.now();

  constructor(private readonly customers: CustomerIdentity[]) {}

  async findCustomerByEmail(email: string) {
    return this.customers.find((c) => c.email.toLowerCase() === email.toLowerCase()) ?? null;
  }

  async createLoginLink(customerId: number, hash: string, ttlMinutes: number, limits: { maxPerHour: number; keepUnused: number }) {
    const t = this.now();
    const recent = this.links.filter((l) => l.customerId === customerId && l.createdAt > t - 3_600_000).length;
    if (recent >= limits.maxPerHour) return false;
    this.links.push({ customerId, hash, createdAt: t, expiresAt: t + ttlMinutes * 60_000, usedAt: null });
    const live = this.links.filter((l) => l.customerId === customerId && l.usedAt === null && l.expiresAt > t);
    for (const l of live.slice(0, Math.max(0, live.length - limits.keepUnused))) l.expiresAt = t; // oldest first
    return true;
  }

  async consumeLoginLink(hash: string) {
    const t = this.now();
    const link = this.links.find((l) => l.hash === hash && l.usedAt === null && l.expiresAt > t);
    if (!link) return null;
    link.usedAt = t;
    return this.customers.find((c) => c.id === link.customerId) ?? null;
  }

  async createSession(customerId: number, hash: string, ttlDays: number) {
    const t = this.now();
    this.sessions.set(hash, { customerId, createdAt: t, lastSeenAt: t, expiresAt: t + ttlDays * 86_400_000 });
  }

  async resolveSession(hash: string) {
    const s = this.sessions.get(hash);
    const t = this.now();
    if (!s || s.expiresAt <= t || s.lastSeenAt <= t - CUSTOMER_IDLE_HOURS * 3_600_000) return null;
    if (s.lastSeenAt < t - 60_000) s.lastSeenAt = t;
    return this.customers.find((c) => c.id === s.customerId) ?? null;
  }

  async deleteSession(hash: string) { this.sessions.delete(hash); }

  async deleteSessionsForCustomer(customerId: number) {
    for (const [h, s] of this.sessions) if (s.customerId === customerId) this.sessions.delete(h);
  }

  async deleteExpired() {
    const t = this.now();
    for (const [h, s] of this.sessions) if (s.expiresAt <= t || s.lastSeenAt <= t - CUSTOMER_IDLE_HOURS * 3_600_000) this.sessions.delete(h);
  }
}
```

- [ ] **Step 3: Failing service tests.** Create `apps/api/src/auth/customer-auth.service.spec.ts`:

```ts
import { Logger, UnauthorizedException } from '@nestjs/common';
import { MemoryCustomerAuthStore } from '../../test/fake-customers';
import { loadConfig } from '../config';
import { CUSTOMER_COOKIE } from './cookie';
import { CustomerAuthService } from './customer-auth.service';
import type { LoginMailer } from './login-mailer';

const AVA = { id: 1, name: 'Ava Brooks', email: 'ava.brooks@example.com' };
const BEN = { id: 2, name: 'Ben Carter', email: 'ben.carter@example.com' };
const MAIL = { CUSTOMER_LOGIN: 'true', LOGIN_SMTP_URL: 'smtp://localhost:1025', LOGIN_EMAIL_FROM: 'support@example.com' };
const T0 = 1_800_000_000_000;

function setup(env: NodeJS.ProcessEnv = {}, mailerOverride?: LoginMailer | null) {
  const store = new MemoryCustomerAuthStore([AVA, BEN]);
  let t = T0;
  store.now = () => t;
  const sent: { to: string; link: string; ttl: number }[] = [];
  const mailer: LoginMailer = { sendLink: async (to, link, ttl) => { sent.push({ to, link, ttl }); }, close: jest.fn() };
  const service = new CustomerAuthService(store, loadConfig({ ...MAIL, ...env }), mailerOverride === undefined ? mailer : mailerOverride);
  const request = async (email: string) => { await service.requestLink(email); await service.drain(); };
  const tokenOf = (link: string) => link.split('#token=')[1];
  return { store, service, sent, request, tokenOf, advance: (ms: number) => { t += ms; } };
}
const cookie = (token: string) => ({ headers: { cookie: `${CUSTOMER_COOKIE}=${token}` } });

afterEach(() => jest.restoreAllMocks());

describe('requestLink', () => {
  it('mails a link to a known customer, matching the email case-insensitively and ignoring surrounding spaces', async () => {
    const { request, sent, tokenOf } = setup();
    await request('  AVA.Brooks@Example.com ');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: AVA.email, ttl: 15 });
    expect(sent[0].link).toMatch(/^http:\/\/localhost:3000\/login#token=[A-Za-z0-9_-]{43}$/);
    expect(tokenOf(sent[0].link)).toHaveLength(43);
  });

  it('does nothing visible for an unknown email: no mail, no stored link', async () => {
    const { request, sent, store } = setup();
    await request('nobody@example.com');
    expect(sent).toHaveLength(0);
    expect(store.links).toHaveLength(0);
  });

  it('does nothing without a mailer (login off)', async () => {
    const { request, store } = setup({}, null);
    await request(AVA.email);
    expect(store.links).toHaveLength(0);
  });

  it('answers before the mail is sent, so a slow mail server cannot tell a known email from an unknown one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: LoginMailer = { sendLink: () => gate, close: jest.fn() };
    const { service } = setup({}, slow);
    const answered = await Promise.race([service.requestLink(AVA.email).then(() => 'answered'), new Promise((r) => setTimeout(() => r('waited'), 200))]);
    expect(answered).toBe('answered');
    release();
    await service.drain();
  });

  it('never lets a mail or store failure escape, and logs neither the address nor the link', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const failing: LoginMailer = { sendLink: async () => { throw Object.assign(new Error(`550 no such user ${AVA.email}`), { code: 'EENVELOPE' }); }, close: jest.fn() };
    const { service } = setup({}, failing);
    await expect(service.requestLink(AVA.email)).resolves.toBeUndefined();
    await expect(service.drain()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toMatch(/ava|example\.com|token=/i);
  });

  it('creates at most 5 links per customer per rolling hour, then goes quiet', async () => {
    const { request, sent, advance } = setup();
    for (let i = 0; i < 7; i++) await request(AVA.email);
    expect(sent).toHaveLength(5);
    await request(BEN.email); // another customer is unaffected
    expect(sent).toHaveLength(6);
    advance(61 * 60_000);
    await request(AVA.email);
    expect(sent).toHaveLength(7);
  });
});

describe('verify', () => {
  it('turns a link into a session and consumes the link', async () => {
    const { request, sent, tokenOf, service } = setup();
    await request(AVA.email);
    const link = tokenOf(sent[0].link);
    const { token, customer } = await service.verify(link);
    expect(customer).toEqual(AVA);
    expect(token).not.toBe(link);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await service.resolve(cookie(token))).toEqual(AVA);
    await expect(service.verify(link)).rejects.toThrow('Invalid or expired link'); // single use
  });

  it('refuses expired, unknown, empty, absurdly long and superseded links with one error', async () => {
    const { request, sent, tokenOf, service, advance } = setup();
    await request(AVA.email);
    advance(16 * 60_000);
    const errors = [
      await service.verify(tokenOf(sent[0].link)).catch((e) => e), // expired
      await service.verify('not-a-real-token').catch((e) => e),
      await service.verify('').catch((e) => e),
      await service.verify('x'.repeat(10_000)).catch((e) => e),
    ];
    for (const e of errors) {
      expect(e).toBeInstanceOf(UnauthorizedException);
      expect(e.message).toBe('Invalid or expired link');
    }
  });

  it('keeps only the 2 newest unused links of a customer', async () => {
    const { request, sent, tokenOf, service, advance } = setup();
    for (let i = 0; i < 3; i++) { await request(AVA.email); advance(1000); }
    await expect(service.verify(tokenOf(sent[0].link))).rejects.toThrow('Invalid or expired link');
    await expect(service.verify(tokenOf(sent[1].link))).resolves.toMatchObject({ customer: AVA });
    await expect(service.verify(tokenOf(sent[2].link))).resolves.toMatchObject({ customer: AVA });
  });

  it('removes expired sessions when someone signs in', async () => {
    const { request, sent, tokenOf, service, advance, store } = setup();
    await request(AVA.email);
    const first = await service.verify(tokenOf(sent[0].link));
    advance(8 * 86_400_000);
    await request(AVA.email);
    await service.verify(tokenOf(sent[1].link));
    expect(store.sessions.size).toBe(1);
    expect(await service.resolve(cookie(first.token))).toBeNull();
  });
});

describe('sessions', () => {
  const signIn = async (ctx: ReturnType<typeof setup>, email = AVA.email) => {
    await ctx.request(email);
    return ctx.service.verify(ctx.tokenOf(ctx.sent.at(-1)!.link));
  };

  it('ends after the absolute lifetime and after 24 idle hours', async () => {
    const ctx = setup({ CUSTOMER_SESSION_TTL_DAYS: '2' });
    const { token } = await signIn(ctx);
    ctx.advance(23 * 3_600_000);
    expect(await ctx.service.resolve(cookie(token))).toEqual(AVA); // keeps it fresh
    ctx.advance(23 * 3_600_000);
    expect(await ctx.service.resolve(cookie(token))).toEqual(AVA);
    ctx.advance(2 * 3_600_000); // 48 h since the start: past the absolute lifetime
    expect(await ctx.service.resolve(cookie(token))).toBeNull();
    const second = await signIn(ctx);
    ctx.advance(25 * 3_600_000);
    expect(await ctx.service.resolve(cookie(second.token))).toBeNull(); // idle
  });

  it('logout ends one session, logoutAll every session of that customer only', async () => {
    const ctx = setup();
    const a1 = await signIn(ctx);
    const a2 = await signIn(ctx);
    const ben = await signIn(ctx, BEN.email);
    await ctx.service.logout(a1.token);
    expect(await ctx.service.resolve(cookie(a1.token))).toBeNull();
    expect(await ctx.service.resolve(cookie(a2.token))).toEqual(AVA);
    await ctx.service.logoutAll(AVA.id);
    expect(await ctx.service.resolve(cookie(a2.token))).toBeNull();
    expect(await ctx.service.resolve(cookie(ben.token))).toEqual(BEN);
  });

  it('knows nothing from a missing, foreign or made-up cookie', async () => {
    const { service } = setup();
    expect(await service.resolve({ headers: {} })).toBeNull();
    expect(await service.resolve({ headers: { cookie: 'reviewer_session=abc' } })).toBeNull();
    expect(await service.resolve(cookie('made-up'))).toBeNull();
  });

  it('reports whether login is on', () => {
    expect(setup().service.enabled).toBe(true);
    expect(new CustomerAuthService(new MemoryCustomerAuthStore([]), loadConfig({}), null).enabled).toBe(false);
  });
});
```

- [ ] **Step 4: Run to see them fail.** `npm test -w apps/api -- src/auth/customer-auth.service`. Expected: compile failure (`./customer-auth.service` missing).

- [ ] **Step 5: Implement the service.** `apps/api/src/auth/customer-auth.service.ts`:

```ts
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
```
Run `npm test -w apps/api -- src/auth`. Expected: all pass. If the idle/absolute test fails, re-read the fake's idle check against the test's clock before touching the service: the fake and the SQL must express "idle = no use for 24 h, refreshed at most once a minute".

- [ ] **Step 6: Failing store e2e.** Create `apps/api/test/customer-auth-store.e2e-spec.ts` (against real SQL; mirrors `reviewer-store.e2e-spec.ts`):

```ts
import type { Pool } from 'pg';
import { PgCustomerAuthStore } from '../src/auth/pg-customer.store';
import { createPool, ensureSchema } from '../src/db/pool';
import { seedDatabase } from '../src/db/seed-data';

// Runs against a real Postgres; skipped unless E2E_DATABASE_URL is set (CI sets it).
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;
const LIMITS = { maxPerHour: 5, keepUnused: 2 };

maybe('customer auth store (e2e, real Postgres)', () => {
  let pool: Pool;
  let store: PgCustomerAuthStore;

  beforeAll(async () => {
    pool = createPool(process.env.E2E_DATABASE_URL!);
    await ensureSchema(pool);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE login_links, customer_sessions CASCADE');
    store = new PgCustomerAuthStore(pool);
  });
  // other suites expect the seeded shop and no reviewers; leave the database as we found it
  afterAll(async () => {
    await seedDatabase(pool);
    await pool.end();
  });

  it('finds a customer by email in any case, and only a real one', async () => {
    const { rows } = await pool.query('SELECT id, name, email FROM customers ORDER BY id LIMIT 1');
    expect(await store.findCustomerByEmail(rows[0].email.toUpperCase())).toEqual(rows[0]);
    expect(await store.findCustomerByEmail('nobody@example.com')).toBeNull();
  });

  describe('login links', () => {
    it('are consumed once, by hash, and give back the customer', async () => {
      expect(await store.createLoginLink(1, 'h1', 15, LIMITS)).toBe(true);
      expect(await store.consumeLoginLink('h1')).toMatchObject({ id: 1 });
      expect(await store.consumeLoginLink('h1')).toBeNull();
      expect(await store.consumeLoginLink('unknown')).toBeNull();
    });

    it('stop working when they expire', async () => {
      await store.createLoginLink(1, 'h1', 15, LIMITS);
      await pool.query(`UPDATE login_links SET expires_at = now() - interval '1 second'`);
      expect(await store.consumeLoginLink('h1')).toBeNull();
    });

    it('eight concurrent consumers of one link: exactly one wins', async () => {
      await store.createLoginLink(1, 'h1', 15, LIMITS);
      await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT pg_sleep(0.05)'))); // open connections first
      const results = await Promise.all(Array.from({ length: 8 }, () => store.consumeLoginLink('h1')));
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it('keep only the newest unused ones, per customer', async () => {
      for (const h of ['a1', 'a2', 'a3']) { await store.createLoginLink(1, h, 15, LIMITS); await pool.query('SELECT pg_sleep(0.01)'); }
      await store.createLoginLink(2, 'b1', 15, LIMITS);
      expect(await store.consumeLoginLink('a1')).toBeNull();
      expect(await store.consumeLoginLink('a2')).not.toBeNull();
      expect(await store.consumeLoginLink('a3')).not.toBeNull();
      expect(await store.consumeLoginLink('b1')).not.toBeNull();
    });

    it('are limited to 5 per customer per rolling hour, even when requested at the same instant', async () => {
      await Promise.all(Array.from({ length: 6 }, () => pool.query('SELECT pg_sleep(0.05)')));
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.createLoginLink(1, `h${i}`, 15, LIMITS)));
      expect(results.filter(Boolean)).toHaveLength(5);
      expect((await pool.query('SELECT count(*)::int AS n FROM login_links WHERE customer_id = 1')).rows[0].n).toBe(5);
      await pool.query(`UPDATE login_links SET created_at = now() - interval '61 minutes'`);
      expect(await store.createLoginLink(1, 'later', 15, LIMITS)).toBe(true);
    });

    it('deleteExpired removes links that expired more than a day ago and keeps recent ones', async () => {
      await store.createLoginLink(1, 'old', 15, LIMITS);
      await store.createLoginLink(2, 'new', 15, LIMITS);
      await pool.query(`UPDATE login_links SET expires_at = now() - interval '2 days' WHERE token_hash = 'old'`);
      await store.deleteExpired();
      expect((await pool.query('SELECT token_hash FROM login_links')).rows).toEqual([{ token_hash: 'new' }]);
    });
  });

  describe('sessions', () => {
    it('resolve to the customer and nothing else', async () => {
      await store.createSession(1, 's1', 7);
      expect(await store.resolveSession('s1')).toMatchObject({ id: 1, name: expect.any(String), email: expect.any(String) });
      expect(await store.resolveSession('other')).toBeNull();
    });

    it('stop after the absolute expiry and after 24 idle hours; a use refreshes at most once a minute', async () => {
      await store.createSession(1, 's1', 7);
      await pool.query(`UPDATE customer_sessions SET expires_at = now() - interval '1 second'`);
      expect(await store.resolveSession('s1')).toBeNull();

      await pool.query('TRUNCATE customer_sessions');
      await store.createSession(1, 's2', 7);
      await pool.query(`UPDATE customer_sessions SET last_seen_at = now() - interval '23 hours'`);
      expect(await store.resolveSession('s2')).not.toBeNull();
      expect((await pool.query(`SELECT last_seen_at > now() - interval '5 seconds' AS fresh FROM customer_sessions`)).rows[0].fresh).toBe(true);
      await pool.query(`UPDATE customer_sessions SET last_seen_at = now() - interval '25 hours'`);
      expect(await store.resolveSession('s2')).toBeNull();

      await pool.query(`UPDATE customer_sessions SET last_seen_at = now() - interval '10 seconds'`);
      const before = (await pool.query('SELECT last_seen_at FROM customer_sessions')).rows[0].last_seen_at;
      await store.resolveSession('s2');
      expect((await pool.query('SELECT last_seen_at FROM customer_sessions')).rows[0].last_seen_at).toBe(before);
    });

    it('delete one, all of a customer, and expired ones; a duplicate hash is refused', async () => {
      await store.createSession(1, 'a1', 7);
      await store.createSession(1, 'a2', 7);
      await store.createSession(2, 'b1', 7);
      await expect(store.createSession(1, 'a1', 7)).rejects.toThrow();
      await store.deleteSession('a1');
      expect(await store.resolveSession('a1')).toBeNull();
      await store.deleteSessionsForCustomer(1);
      expect(await store.resolveSession('a2')).toBeNull();
      expect(await store.resolveSession('b1')).not.toBeNull();
      await pool.query(`UPDATE customer_sessions SET expires_at = now() - interval '1 minute'`);
      await store.createSession(2, 'b2', 7);
      await store.deleteExpired();
      expect((await pool.query('SELECT token_hash FROM customer_sessions')).rows).toEqual([{ token_hash: 'b2' }]);
    });
  });
});
```
Run: `export E2E_DATABASE_URL=...; npm test -w apps/api -- test/customer-auth-store`. Expected: compile failure (`pg-customer.store` missing).

- [ ] **Step 7: Implement the Postgres store.** `apps/api/src/auth/pg-customer.store.ts`:

```ts
import type { Pool } from 'pg';
import { CUSTOMER_IDLE_HOURS, type CustomerAuthStore, type CustomerIdentity } from './customer.store';

export class PgCustomerAuthStore implements CustomerAuthStore {
  constructor(private readonly pool: Pool) {}

  async findCustomerByEmail(email: string): Promise<CustomerIdentity | null> {
    const { rows } = await this.pool.query('SELECT id, name, email FROM customers WHERE lower(email) = lower($1)', [email]);
    return rows[0] ?? null;
  }

  async createLoginLink(customerId: number, tokenHash: string, ttlMinutes: number, limits: { maxPerHour: number; keepUnused: number }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One lock per customer, so counting and inserting are one decision even for simultaneous requests.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`login-link:${customerId}`]);
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM login_links WHERE customer_id = $1 AND created_at > now() - interval '1 hour'`, [customerId]);
      if (rows[0].n >= limits.maxPerHour) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        'INSERT INTO login_links (customer_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))',
        [customerId, tokenHash, ttlMinutes],
      );
      // Only the newest few unused links stay usable.
      await client.query(
        `UPDATE login_links SET expires_at = now()
          WHERE customer_id = $1 AND used_at IS NULL AND expires_at > now()
            AND id NOT IN (SELECT id FROM login_links WHERE customer_id = $1 AND used_at IS NULL AND expires_at > now()
                           ORDER BY created_at DESC, id DESC LIMIT $2)`,
        [customerId, limits.keepUnused],
      );
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** One statement: two requests with the same token cannot both succeed. */
  async consumeLoginLink(tokenHash: string): Promise<CustomerIdentity | null> {
    const { rows } = await this.pool.query(
      `UPDATE login_links l SET used_at = now() FROM customers c
        WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.expires_at > now() AND c.id = l.customer_id
        RETURNING c.id, c.name, c.email`,
      [tokenHash],
    );
    return rows[0] ?? null;
  }

  async createSession(customerId: number, tokenHash: string, ttlDays: number): Promise<void> {
    await this.pool.query(
      'INSERT INTO customer_sessions (customer_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))',
      [customerId, tokenHash, ttlDays],
    );
  }

  async resolveSession(tokenHash: string): Promise<CustomerIdentity | null> {
    const { rows } = await this.pool.query(
      `SELECT c.id, c.name, c.email FROM customer_sessions s JOIN customers c ON c.id = s.customer_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(hours => $2)`,
      [tokenHash, CUSTOMER_IDLE_HOURS],
    );
    if (!rows[0]) return null;
    // at most one write a minute per session
    await this.pool.query(
      `UPDATE customer_sessions SET last_seen_at = now() WHERE token_hash = $1 AND last_seen_at < now() - interval '1 minute'`, [tokenHash]);
    return rows[0];
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM customer_sessions WHERE token_hash = $1', [tokenHash]);
  }

  async deleteSessionsForCustomer(customerId: number): Promise<void> {
    await this.pool.query('DELETE FROM customer_sessions WHERE customer_id = $1', [customerId]);
  }

  async deleteExpired(): Promise<void> {
    await this.pool.query(
      'DELETE FROM customer_sessions WHERE expires_at <= now() OR last_seen_at <= now() - make_interval(hours => $1)', [CUSTOMER_IDLE_HOURS]);
    await this.pool.query(`DELETE FROM login_links WHERE expires_at < now() - interval '1 day'`);
  }
}
```

- [ ] **Step 8: Run.** `export E2E_DATABASE_URL=...; npm test -w apps/api -- test/customer-auth-store src/auth` then root `npm run typecheck`. Expected: pass. Then mutation-check the two concurrency tests: temporarily delete the `pg_advisory_xact_lock` line and run the limit test (it must fail), restore; temporarily change `l.used_at IS NULL AND` out of `consumeLoginLink` (the single-use test must fail), restore.
- [ ] **Step 9: Full suite and commit.** Run `npm test` (root, with `E2E_DATABASE_URL`). Commit `Add the customer link and session store and the customer auth service`. Ledger test command: `npm test -w apps/api`.

---

### Task 3: The customer principal and conversation access

**Files:**
- Modify: `apps/api/src/auth/principal.ts`, `principal.middleware.ts`, `csrf.ts`, `auth.service.ts` (startup warning), `apps/api/src/db/pg-agent.store.ts`, `apps/api/src/db/database.module.ts`, `apps/api/src/agent/agent.module.ts`, `apps/api/src/http/conversation-access.guard.ts`, `conversations.controller.ts`, `dto.ts`, `health.controller.ts`; tests `principal.spec.ts` (new), `principal.middleware.spec.ts` (new), `csrf.spec.ts`, `auth.service.spec.ts`
- Create: `apps/api/src/http/customer.guard.ts`, `apps/api/test/customer-access.e2e-spec.ts`
- Modify (named change): `apps/api/test/approval-flow.e2e-spec.ts` (the `/health` expectation gains `customerLogin: false`)

**Interfaces:**
- Consumes: `CustomerAuthService`, `CUSTOMER_AUTH_STORE`, `LOGIN_MAILER`, `createLoginMailer`, `PgCustomerAuthStore`, `hashToken` (Tasks 1-2).
- Produces:
  ```ts
  // principal.ts
  export type Principal = ... | { kind: 'customer'; customerId: number; email: string; name: string };
  export type CustomerPrincipal = Extract<Principal, { kind: 'customer' }>;
  export const isReviewerPrincipal: (p: Principal) => boolean;   // demo | key | reviewer ONLY (customer is false)
  export const customerOf: (p: Principal) => CustomerPrincipal | null;
  // csrf.ts
  export const hasCsrfHeader: (req: Pick<Request, 'headers'>) => boolean;
  export function csrfOk(req, principal): boolean;               // now also true-only-with-header for customer mutations
  // PgAgentStore
  conversationBelongsToCustomer(conversationId: string, customerId: number): Promise<boolean>;
  createConversationForCustomer(customerId: number, title: string): Promise<Conversation>;   // no access token
  listConversationsForCustomer(customerId: number): Promise<MyConversation[]>;
  export interface MyConversation { id: string; title: string; createdAt: string; lastStatus: string | null; awaitingApproval: boolean }
  // routes: POST /conversations (login mode: customer session), GET /my/conversations (CustomerGuard), GET /health adds customerLogin
  ```

- [ ] **Step 1: Failing unit tests.**

Create `apps/api/src/auth/principal.spec.ts`:

```ts
import { customerOf, isReviewerPrincipal, principalOf, reviewerOf, type Principal } from './principal';

const all: Record<string, Principal> = {
  demo: { kind: 'demo' }, key: { kind: 'key' },
  reviewer: { kind: 'reviewer', id: 'r1', email: 'a@b.c', name: 'A', role: 'reviewer' },
  customer: { kind: 'customer', customerId: 1, email: 'ava@example.com', name: 'Ava' },
  none: { kind: 'none' },
};

describe('principals', () => {
  it('only demo, key and reviewer are reviewers: a customer and an anonymous caller are not', () => {
    expect(Object.entries(all).filter(([, p]) => isReviewerPrincipal(p)).map(([k]) => k)).toEqual(['demo', 'key', 'reviewer']);
  });

  it('customerOf and reviewerOf only match their own kind', () => {
    expect(customerOf(all.customer)).toEqual(all.customer);
    for (const k of ['demo', 'key', 'reviewer', 'none']) expect(customerOf(all[k])).toBeNull();
    expect(reviewerOf(all.customer)).toBeNull();
  });

  it('no principal means none', () => {
    expect(principalOf({} as never)).toEqual({ kind: 'none' });
  });
});
```

Extend `csrf.spec.ts` (add a customer to the cookie group):

```ts
const customer: Principal = { kind: 'customer', customerId: 1, email: 'ava@example.com', name: 'Ava' };

describe('csrfOk for a customer session', () => {
  it('lets reads through and requires the header for mutations, like a reviewer cookie', () => {
    expect(csrfOk(req('GET'), customer)).toBe(true);
    expect(csrfOk(req('POST'), customer)).toBe(false);
    expect(csrfOk(req('POST', 'something-else'), customer)).toBe(false);
    expect(csrfOk(req('POST', 'reviewer-console'), customer)).toBe(true);
  });

  it('hasCsrfHeader is true only for the exact value', () => {
    expect(hasCsrfHeader(req('POST', 'reviewer-console'))).toBe(true);
    expect(hasCsrfHeader(req('POST'))).toBe(false);
    expect(hasCsrfHeader(req('POST', 'x'))).toBe(false);
  });
});
```
(import `hasCsrfHeader` in that spec.)

Create `apps/api/src/auth/principal.middleware.spec.ts`:

```ts
import type { Request, Response } from 'express';
import type { AuthService } from './auth.service';
import type { CustomerAuthService } from './customer-auth.service';
import type { CustomerIdentity } from './customer.store';
import type { Principal } from './principal';
import { PrincipalMiddleware } from './principal.middleware';

const AVA: CustomerIdentity = { id: 1, name: 'Ava', email: 'ava@example.com' };
const reviewer: Principal = { kind: 'reviewer', id: 'r1', email: 'a@b.c', name: 'A', role: 'admin' };

async function run(reviewerSide: Principal, customer: CustomerIdentity | null | Error, enabled = true) {
  const resolve = jest.fn(async () => { if (customer instanceof Error) throw customer; return customer; });
  const auth = { resolvePrincipal: async () => reviewerSide } as unknown as AuthService;
  const customers = { enabled, resolve } as unknown as CustomerAuthService;
  const req = { headers: {} } as Request;
  const next = jest.fn();
  await new PrincipalMiddleware(auth, customers).use(req, {} as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  return { principal: req.principal, resolve };
}

describe('PrincipalMiddleware with customer login', () => {
  it('a valid customer session wins over an anonymous caller and over the open demo', async () => {
    const expected = { kind: 'customer', customerId: 1, email: AVA.email, name: AVA.name };
    expect((await run({ kind: 'none' }, AVA)).principal).toEqual(expected);
    expect((await run({ kind: 'demo' }, AVA)).principal).toEqual(expected);
  });

  it('a reviewer cookie or the shared key wins over a customer cookie, which is not even consulted', async () => {
    for (const p of [reviewer, { kind: 'key' } as Principal]) {
      const { principal, resolve } = await run(p, AVA);
      expect(principal).toEqual(p);
      expect(resolve).not.toHaveBeenCalled();
    }
  });

  it('stays what it was without a customer session, and fails closed when the lookup breaks', async () => {
    expect((await run({ kind: 'none' }, null)).principal).toEqual({ kind: 'none' });
    expect((await run({ kind: 'demo' }, null)).principal).toEqual({ kind: 'demo' });
    expect((await run({ kind: 'none' }, new Error('db down'))).principal).toEqual({ kind: 'none' });
  });

  it('never looks for a customer when login is off', async () => {
    const { principal, resolve } = await run({ kind: 'none' }, AVA, false);
    expect(principal).toEqual({ kind: 'none' });
    expect(resolve).not.toHaveBeenCalled();
  });
});
```

Append to `auth.service.spec.ts` (the startup warnings):

```ts
describe('startup warning for customer login with open reviewer routes', () => {
  const MAIL = { CUSTOMER_LOGIN: 'true', LOGIN_SMTP_URL: 'smtp://localhost:1025', LOGIN_EMAIL_FROM: 'support@example.com' };

  it('warns when login is on but there is neither a reviewer key nor a reviewer account', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { auth } = await setup(MAIL);
    await auth.onApplicationBootstrap();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/customer login.*reviewer routes are open/i);
  });

  it('stays quiet with a reviewer key, with a reviewer account, or with login off', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await (await setup({ ...MAIL, REVIEWER_API_KEY: 'k' })).auth.onApplicationBootstrap();
    const withAccount = await setup(MAIL);
    await withAccount.add();
    await withAccount.auth.onApplicationBootstrap();
    await (await setup()).auth.onApplicationBootstrap();
    expect(warn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to see them fail.** `npm test -w apps/api -- src/auth`. Expected: failures (no `customer` kind, no `hasCsrfHeader`, middleware constructor arity, no customer warning).

- [ ] **Step 3: Implement the principal pieces.**

`principal.ts`: add the union member and helpers and **fix `isReviewerPrincipal`**:

```ts
export type Principal =
  | { kind: 'demo' }
  | { kind: 'key' }
  | { kind: 'reviewer'; id: string; email: string; name: string; role: 'admin' | 'reviewer' }
  | { kind: 'customer'; customerId: number; email: string; name: string }
  | { kind: 'none' };

export type CustomerPrincipal = Extract<Principal, { kind: 'customer' }>;

/** True for demo, key and signed-in reviewers. A customer is NOT a reviewer: it must never pass a reviewer check. */
export const isReviewerPrincipal = (p: Principal): boolean => p.kind === 'demo' || p.kind === 'key' || p.kind === 'reviewer';

/** The signed-in customer, if the caller is one. */
export const customerOf = (p: Principal): CustomerPrincipal | null => (p.kind === 'customer' ? p : null);
```
(also update the comment above `Principal`: "Customers are `none` ..." → "Anonymous callers are `none`, customers use their session (login mode) or their conversation token.")

`csrf.ts`:

```ts
export const hasCsrfHeader = (req: Pick<Request, 'headers'>): boolean => req.headers[CSRF_HEADER] === CSRF_VALUE;

export function csrfOk(req: Pick<Request, 'method' | 'headers'>, principal: Principal): boolean {
  if (principal.kind !== 'reviewer' && principal.kind !== 'customer') return true; // no ambient credentials
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  return hasCsrfHeader(req);
}
```
Update its doc comment to say "cookie" covers both session cookies.

`principal.middleware.ts`:

```ts
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AuthService } from './auth.service';
import { CustomerAuthService } from './customer-auth.service';

/** Runs before every route so guards, controllers and SSE streams all read the same `req.principal`. */
@Injectable()
export class PrincipalMiddleware implements NestMiddleware {
  constructor(private readonly auth: AuthService, private readonly customers: CustomerAuthService) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    let principal = await this.auth.resolvePrincipal(req);
    // A reviewer (cookie or shared key) wins. An anonymous caller, or the open demo, gives way to a valid customer session.
    if (this.customers.enabled && (principal.kind === 'none' || principal.kind === 'demo')) {
      const customer = await this.customers.resolve(req).catch(() => null); // fail closed
      if (customer) principal = { kind: 'customer', customerId: customer.id, email: customer.email, name: customer.name };
    }
    req.principal = principal;
    next();
  }
}
```

`auth.service.ts` `onApplicationBootstrap`: replace the body with

```ts
  async onApplicationBootstrap(): Promise<void> {
    const eyes = this.cfg.approvalPolicy.fourEyes;
    const fourEyes = Boolean(eyes && (eyes.refundOver > 0 || eyes.cancellations));
    const openReviewerSide = this.cfg.customerLogin.enabled && !this.cfg.reviewerApiKey;
    if (!fourEyes && !openReviewerSide) return;
    try {
      // a direct read, not hasAnyReviewer(): a one-off startup check must not seed that answer's short cache
      if ((await this.store.listReviewers()).length > 0) return;
      if (fourEyes) {
        this.log.warn('Four-eyes approval is configured but no reviewer accounts exist: two-approval actions cannot be approved by the shared key or in demo mode. Create one with `npm run reviewer:add -w apps/api`.');
      }
      if (openReviewerSide) {
        this.log.warn('Customer login is on but reviewer routes are open (no REVIEWER_API_KEY and no reviewer account): anyone can use /approvals. Create a reviewer with `npm run reviewer:add -w apps/api` or set REVIEWER_API_KEY.');
      }
    } catch {
      // the first request will report a database problem; the warning is advice only
    }
  }
```
Keep its doc comment, mention both warnings.

- [ ] **Step 4: Wire the providers.** `database.module.ts`: add `import { PgCustomerAuthStore } from '../auth/pg-customer.store';` and `CUSTOMER_AUTH_STORE` to the `../auth/tokens` import; provider `{ provide: CUSTOMER_AUTH_STORE, inject: [PG_POOL], useFactory: (pool: Pool) => new PgCustomerAuthStore(pool) },`; add `CUSTOMER_AUTH_STORE` to `exports`. `agent.module.ts`: import `CustomerAuthService`, `createLoginMailer`, `LOGIN_MAILER`, `LoginMailer`; add to `providers`:

```ts
    {
      provide: LOGIN_MAILER,
      inject: [APP_CONFIG],
      // null when login is off: nothing can send mail, and no SMTP settings are needed
      useFactory: (cfg: AppConfig): LoginMailer | null =>
        cfg.customerLogin.enabled && cfg.customerLogin.mail ? createLoginMailer(cfg.customerLogin.mail) : null,
    },
    CustomerAuthService,
```

- [ ] **Step 5: Run unit tests.** `npm test -w apps/api -- src/auth` then root `npm run typecheck` (errors will point at `isReviewerPrincipal`/`Principal` consumers; fix only type fallout). Expected: pass.

- [ ] **Step 6: Failing e2e for access.** Create `apps/api/test/customer-access.e2e-spec.ts`. It boots with login on, mints sessions straight through the store (no mail), and covers the Review Focus items. Key helpers and cases (write them all; the executor must not shorten them):

```ts
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { hashToken, newToken } from '../src/auth/session-token';
import { CUSTOMER_AUTH_STORE, REVIEWER_STORE } from '../src/auth/tokens';
import type { CustomerAuthStore } from '../src/auth/customer.store';
import type { ReviewerStore } from '../src/auth/reviewer.store';
import { PgAgentStore } from '../src/db/pg-agent.store';
import { createPool } from '../src/db/pool';
import { seedDatabase } from '../src/db/seed-data';
import { configureApp } from '../src/http/setup';
import { PG_POOL } from '../src/tokens';

const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

const CSRF = { 'X-Requested-By': 'reviewer-console' };
const LOGIN_ENV = { CUSTOMER_LOGIN: 'true', LOGIN_SMTP_URL: 'smtp://localhost:1025', LOGIN_EMAIL_FROM: 'support@example.com' };
const ENV_KEYS = ['CUSTOMER_LOGIN', 'LOGIN_SMTP_URL', 'LOGIN_EMAIL_FROM', 'REVIEWER_API_KEY', 'CUSTOMER_APP_URL'];
const REFUND = 'Order #1 arrived damaged, please refund it'; // customer 1 owns order 1
const HIDDEN = ['policyRule', 'policyDetail', 'notifiedAt', 'approvalsRequired', 'approvalsGiven', 'approvedBy', 'approvedByIds'];

maybe('customer login: conversation access (e2e, real Postgres)', () => {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let app: INestApplication;
  let pool: Pool;
  let customers: CustomerAuthStore;
  const http = () => request(app.getHttpServer());

  const boot = async (env: Record<string, string> = LOGIN_ENV) => {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    Object.assign(process.env, env);
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    configureApp(app);
    await app.init();
    pool = app.get(PG_POOL);
    customers = app.get(CUSTOMER_AUTH_STORE);
    await seedDatabase(pool);
  };

  /** A signed-in customer's Cookie header, minted without email. */
  const signIn = async (customerId: number) => {
    const token = newToken();
    await customers.createSession(customerId, hashToken(token), 7);
    return `customer_session=${token}`;
  };
  const start = async (cookie: string) => (await http().post('/conversations').set('Cookie', cookie).set(CSRF).send({}).expect(201)).body;

  afterEach(async () => {
    await app?.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });
  afterAll(async () => {
    const cleanup = createPool(process.env.E2E_DATABASE_URL!);
    await seedDatabase(cleanup);
    await cleanup.end();
  });

  describe('starting a conversation', () => {
    beforeEach(() => boot());

    it('binds it to the signed-in customer, issues no access token, and needs the CSRF header', async () => {
      const ava = await signIn(1);
      await http().post('/conversations').set('Cookie', ava).send({}).expect(403);
      const conv = await start(ava);
      expect(conv).toMatchObject({ customerId: 1, customerName: 'Ava Brooks' });
      expect(conv).not.toHaveProperty('accessToken');
      expect((await pool.query('SELECT access_token_hash FROM conversations WHERE id = $1', [conv.id])).rows[0].access_token_hash).toBeNull();
    });

    it('refuses a customerId or email in the body, and anyone who is not a signed-in customer', async () => {
      const ava = await signIn(1);
      await http().post('/conversations').set('Cookie', ava).set(CSRF).send({ customerId: 2 }).expect(400);
      await http().post('/conversations').set('Cookie', ava).set(CSRF).send({ email: 'ben.carter@example.com' }).expect(400);
      await http().post('/conversations').set(CSRF).send({}).expect(401);
      await http().post('/conversations').set(CSRF).send({ customerId: 1 }).expect(401); // the old open way is closed
      await http().post('/conversations').set('Cookie', 'customer_session=made-up').set(CSRF).send({}).expect(401);
    });
  });

  describe('reading and writing a conversation', () => {
    beforeEach(() => boot());

    it('is open to its own customer only; every other caller gets the identical 401', async () => {
      const [ava, ben] = [await signIn(1), await signIn(2)];
      const conv = await start(ava);
      await http().get(`/conversations/${conv.id}`).set('Cookie', ava).expect(200);
      const unknown = await http().get('/conversations/00000000-0000-4000-8000-000000000000').set('Cookie', ben).expect(401);
      const wrong = await http().get(`/conversations/${conv.id}`).set('Cookie', ben).expect(401);
      const anonymous = await http().get(`/conversations/${conv.id}`).expect(401);
      expect(wrong.body).toEqual(unknown.body);
      expect(anonymous.body).toEqual(unknown.body);
      await http().post(`/conversations/${conv.id}/messages`).set('Cookie', ben).set(CSRF).send({ content: 'hi' }).expect(401);
      await http().post(`/conversations/${conv.id}/messages`).set('Cookie', ava).send({ content: 'hi' }).expect(403); // CSRF
      await http().post(`/conversations/${conv.id}/messages`).set('Cookie', ava).set(CSRF).send({ content: 'Show my recent orders' }).expect(201);
    });

    it('does not accept a conversation token in login mode, even a real one', async () => {
      const legacy = await app.get(PgAgentStore).createConversation(1, 'before login mode');
      await http().get(`/conversations/${legacy.id}`).set('X-Conversation-Token', legacy.accessToken).expect(401);
      const ava = await signIn(1);
      await http().get(`/conversations/${legacy.id}`).set('Cookie', ava).expect(200); // ...but its customer can sign in and read it
      await http().get(`/conversations/${legacy.id}`).set('Cookie', ava).set('X-Conversation-Token', 'wrong').expect(200); // the token is simply ignored
    });

    it('the stream follows the same rule', async () => {
      const [ava, ben] = [await signIn(1), await signIn(2)];
      const conv = await start(ava);
      await app.listen(0);
      const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
      expect((await fetch(`${base}/conversations/${conv.id}/events`)).status).toBe(401);
      expect((await fetch(`${base}/conversations/${conv.id}/events`, { headers: { Cookie: ben } })).status).toBe(401);
      const ctrl = new AbortController();
      const ok = await fetch(`${base}/conversations/${conv.id}/events`, { headers: { Cookie: ava }, signal: ctrl.signal });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toContain('text/event-stream');
      ctrl.abort();
      await ok.body?.cancel().catch(() => undefined);
    });
  });

  describe('my conversations', () => {
    beforeEach(() => boot());

    it('lists only the caller\'s own, newest first, in the customer shape; anonymous is 401', async () => {
      const [ava, ben] = [await signIn(1), await signIn(2)];
      const first = await start(ava);
      const second = await start(ava);
      await start(ben);
      const mine = (await http().get('/my/conversations').set('Cookie', ava).expect(200)).body;
      expect(mine.map((c: { id: string }) => c.id)).toEqual([second.id, first.id]);
      expect(Object.keys(mine[0]).sort()).toEqual(['awaitingApproval', 'createdAt', 'id', 'lastStatus', 'title']);
      expect(mine[0]).toMatchObject({ awaitingApproval: false, lastStatus: null });
      await http().get('/my/conversations').expect(401);
    });

    it('shows an earlier conversation made before login mode, and reports one waiting for approval', async () => {
      const legacy = await app.get(PgAgentStore).createConversation(1, 'old chat');
      const ava = await signIn(1);
      const conv = await start(ava);
      await http().post(`/conversations/${conv.id}/messages`).set('Cookie', ava).set(CSRF).send({ content: REFUND }).expect(201);
      const mine = (await http().get('/my/conversations').set('Cookie', ava).expect(200)).body;
      expect(mine.map((c: { id: string }) => c.id).sort()).toEqual([legacy.id, conv.id].sort());
      expect(mine.find((c: { id: string }) => c.id === conv.id)).toMatchObject({ awaitingApproval: true, lastStatus: 'awaiting_approval' });
    });
  });

  describe('a customer is not a reviewer', () => {
    beforeEach(() => boot());

    it('gets 401 on every reviewer route', async () => {
      const ava = await signIn(1);
      for (const path of ['/approvals', '/approvals/events', '/customers', '/conversations', '/events', '/reviewers']) {
        await http().get(path).set('Cookie', ava).expect(401);
      }
      await http().post('/approvals/00000000-0000-4000-8000-000000000000').set('Cookie', ava).set(CSRF).send({ decision: 'approve' }).expect(401);
    });

    it('sees the customer view of a parked approval; a reviewer sees the policy fields', async () => {
      await app.close();
      await boot({ ...LOGIN_ENV, REVIEWER_API_KEY: 'rev-key' });
      const ava = await signIn(1);
      const conv = await start(ava);
      await http().post(`/conversations/${conv.id}/messages`).set('Cookie', ava).set(CSRF).send({ content: REFUND }).expect(201);
      const mine = (await http().get(`/conversations/${conv.id}`).set('Cookie', ava).expect(200)).body;
      expect(mine.approvals).toHaveLength(1);
      for (const key of HIDDEN) expect(mine.approvals[0]).not.toHaveProperty(key);
      const asReviewer = (await http().get(`/conversations/${conv.id}`).set('Authorization', 'Bearer rev-key').expect(200)).body;
      expect(asReviewer.approvals[0]).toHaveProperty('policyRule');
      expect(asReviewer.approvals[0]).toHaveProperty('notifiedAt');
    });
  });

  describe('modes', () => {
    it('the open demo does not let an anonymous caller into conversations, yet a customer session works there', async () => {
      await boot(); // no reviewers, no key: demo reviewer mode
      expect((await http().get('/approvals').expect(200)).body).toBeDefined(); // reviewer routes stay open, as the demo promises
      const ava = await signIn(1);
      const conv = await start(ava);
      await http().get(`/conversations/${conv.id}`).expect(401);
      await http().get(`/conversations/${conv.id}`).set('Cookie', ava).expect(200);
      await http().get('/conversations').expect(200); // still the open demo list for reviewers
    });

    it('a reviewer cookie wins over a customer cookie and sees every conversation', async () => {
      await boot();
      const store: ReviewerStore = app.get(REVIEWER_STORE);
      await store.createReviewer({ email: 'rev@example.com', name: 'Rev', role: 'reviewer', passwordHash: await hashPassword('correct horse battery') });
      const login = await http().post('/auth/login').set(CSRF).send({ email: 'rev@example.com', password: 'correct horse battery' }).expect(200);
      const reviewerCookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      const ava = await signIn(1);
      const conv = await start(ava);
      const both = `${reviewerCookie}; ${ava}`;
      await http().get('/approvals').set('Cookie', both).expect(200);
      await http().get(`/conversations/${conv.id}`).set('Cookie', reviewerCookie).expect(200);
      await http().get('/approvals').set('Cookie', ava).expect(401); // the customer cookie alone is not a reviewer
      await http().get('/conversations').set('Cookie', ava).expect(401);
    });

    it('with login off nothing changes: the old open start works, `{}` is 400, /my/conversations is 401, health says so', async () => {
      await boot({ CUSTOMER_LOGIN: 'false' });
      await http().post('/conversations').send({}).expect(400);
      const conv = (await http().post('/conversations').send({ customerId: 1 }).expect(201)).body;
      await http().get(`/conversations/${conv.id}`).set('X-Conversation-Token', conv.accessToken).expect(200);
      await http().get('/my/conversations').expect(401);
      expect((await http().get('/health').expect(200)).body).toMatchObject({ customerLogin: false });
    });

    it('health says customer login is on', async () => {
      await boot();
      expect((await http().get('/health').expect(200)).body).toMatchObject({ customerLogin: true });
    });
  });
});
```
Also update the `/health` expectation in `approval-flow.e2e-spec.ts` to `{ status: 'ok', db: 'up', provider: 'mock', reviewerAuth: false, reviewerAccounts: false, customerLogin: false }`.

- [ ] **Step 7: Run to see the e2e fail.** `export E2E_DATABASE_URL=...; npm test -w apps/api -- test/customer-access`. Expected: failures (404 on `/my/conversations`, guard still token-based, etc.).

- [ ] **Step 8: Implement store methods, guard, controller, DTO, health.**

`pg-agent.store.ts` (next to `createConversation`):

```ts
  /** Login mode: no token is issued, so the conversation is reachable only through its customer's session (or a reviewer). */
  async createConversationForCustomer(customerId: number, title: string): Promise<Conversation> {
    const { rows } = await this.pool.query('INSERT INTO conversations (customer_id, title) VALUES ($1, $2) RETURNING id', [customerId, title]);
    return (await this.getConversation(rows[0].id))!;
  }

  async conversationBelongsToCustomer(conversationId: string, customerId: number): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM conversations WHERE id = $1 AND customer_id = $2', [conversationId, customerId]);
    return (rowCount ?? 0) > 0;
  }

  /** What a customer may see in their own list: no token usage, no reviewer counts. */
  async listConversationsForCustomer(customerId: number): Promise<MyConversation[]> {
    const { rows } = await this.pool.query(
      `SELECT c.id, c.title, c.created_at,
              (SELECT status FROM runs r WHERE r.conversation_id = c.id ORDER BY r.created_at DESC LIMIT 1) AS last_status,
              EXISTS (SELECT 1 FROM actions a WHERE a.conversation_id = c.id AND a.status = 'pending_approval') AS awaiting_approval
         FROM conversations c WHERE c.customer_id = $1 ORDER BY c.created_at DESC, c.id DESC LIMIT 100`,
      [customerId],
    );
    return rows.map((r) => camel<MyConversation>(r));
  }
```
and export `export interface MyConversation { id: string; title: string; createdAt: string; lastStatus: string | null; awaitingApproval: boolean }` beside `ConversationSummary`.

`http/customer.guard.ts`:

```ts
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
```

`conversation-access.guard.ts` (full replacement of `canActivate`; constructor gains `@Inject(APP_CONFIG) private readonly cfg: AppConfig`; add imports `Inject`, `AppConfig`, `APP_CONFIG`, `customerOf`):

```ts
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
```
with `const LOGIN_DENIED = 'Sign in to access this conversation';` at module level, and update the class comment (mention the login-mode rules).

`dto.ts`: replace `CreateConversationDto` with optional fields (the "one of them required" rule moves into the controller, because login mode needs neither):

```ts
export class CreateConversationDto {
  /** Login off: either customerId or email identifies who the conversation is bound to. Login on: neither is accepted. */
  @IsOptional() @IsInt() @Min(1) @Max(2_147_483_647)
  customerId?: number;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(120) @noNul()
  title?: string;
}
```
(remove the now-unused `ValidateIf` import only if nothing else uses it.)

`conversations.controller.ts`: imports `BadRequestException, ForbiddenException, UnauthorizedException`, `csrfOk`, `customerOf`, `CustomerGuard`. Replace `create`:

```ts
  /** Login off: returns the conversation plus its one-time `accessToken`. Login on: only a signed-in customer may start one, as themselves. */
  @Post('conversations')
  @limited((l) => l.startPerMinute)
  async create(@Body() dto: CreateConversationDto, @Req() req: Request) {
    if (this.cfg.customerLogin.enabled) return this.createForCustomer(dto, req);
    if (dto.customerId === undefined && dto.email === undefined) throw new BadRequestException('customerId or email is required');
    const customer = dto.customerId
      ? await this.shop.getCustomer(dto.customerId)
      : await this.pool.query('SELECT id, name, email FROM customers WHERE lower(email) = lower($1)', [dto.email]).then((r) => r.rows[0]);
    if (!customer) throw new NotFoundError(`Customer ${dto.customerId ?? dto.email} not found`);
    return this.store.createConversation(customer.id, dto.title ?? `Chat with ${customer.name}`);
  }

  private async createForCustomer(dto: CreateConversationDto, req: Request) {
    const principal = principalOf(req);
    const customer = customerOf(principal);
    if (!customer) throw new UnauthorizedException('Sign in to start a conversation');
    if (!csrfOk(req, principal)) throw new ForbiddenException('Missing X-Requested-By header');
    if (dto.customerId !== undefined || dto.email !== undefined) {
      throw new BadRequestException('customerId and email are not accepted: a conversation belongs to the signed-in customer');
    }
    return this.store.createConversationForCustomer(customer.customerId, dto.title ?? `Chat with ${customer.name}`);
  }

  /** The signed-in customer's own conversations (login mode). */
  @Get('my/conversations')
  @UseGuards(CustomerGuard)
  my(@Req() req: Request) {
    return this.store.listConversationsForCustomer(customerOf(principalOf(req))!.customerId); // CustomerGuard guarantees a customer
  }
```
`health.controller.ts`: add `customerLogin: this.cfg.customerLogin.enabled` to the OK payload.

- [ ] **Step 9: Run.** `export E2E_DATABASE_URL=...; npm test -w apps/api -- test/customer-access` then the whole API suite twice and root `npm run typecheck`. Every existing suite must pass unchanged (the `/health` assertion is the one named edit; `POST /conversations {}` must still be `400`). If an existing test asserted class-validator's exact message for the old DTO, change only that expectation and ledger it.
- [ ] **Step 10: Mutation checks.** Temporarily revert `isReviewerPrincipal` to `p.kind !== 'none'`: the "customer is not a reviewer" tests and `principal.spec.ts` must fail; restore. Temporarily delete the `!(login && principal.kind === 'demo')` clause: the demo test must fail; restore.
- [ ] **Step 11: Commit** `Add the customer principal and bind conversation access to the verified customer`. Ledger test command: `npm test -w apps/api`.

---

### Task 4: The `/customer-auth` routes

**Files:**
- Create: `apps/api/src/http/customer-auth.controller.ts`, `apps/api/src/http/login-enabled.guard.ts`, `apps/api/src/http/csrf-header.guard.ts`, `apps/api/test/customer-auth.e2e-spec.ts`
- Modify: `apps/api/src/http/dto.ts`, `apps/api/src/http/rate-limit.ts`, `apps/api/src/agent/agent.module.ts` (controller)

**Interfaces:**
- Consumes: `CustomerAuthService`, `customerCookieOptions`, `CUSTOMER_COOKIE`, `CustomerGuard`, `hasCsrfHeader`, `loadCustomerLoginLimit` (Tasks 1-3).
- Produces (HTTP): `POST /customer-auth/request { email }` → `202 { status: 'sent' }`; `POST /customer-auth/verify { token }` → `200 { customer: { id, name, email } }` + `Set-Cookie customer_session`; `POST /customer-auth/logout` → 204; `POST /customer-auth/logout-all` → 204; `GET /customer-auth/me` → `{ customer }`. All `404` when login is off.

- [ ] **Step 1: Failing e2e.** Create `apps/api/test/customer-auth.e2e-spec.ts`. Boot with the login env and override `LOGIN_MAILER` with a capturing fake. Required helpers and cases (all of them):

```ts
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CustomerAuthService } from '../src/auth/customer-auth.service';
import { LOGIN_MAILER } from '../src/auth/tokens';
import { PgAgentStore } from '../src/db/pg-agent.store';
import { createPool } from '../src/db/pool';
import { seedDatabase } from '../src/db/seed-data';
import { configureApp } from '../src/http/setup';
import { PG_POOL } from '../src/tokens';

const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;
const CSRF = { 'X-Requested-By': 'reviewer-console' };
const LOGIN_ENV = { CUSTOMER_LOGIN: 'true', LOGIN_SMTP_URL: 'smtp://localhost:1025', LOGIN_EMAIL_FROM: 'support@example.com' };
const ENV_KEYS = ['CUSTOMER_LOGIN', 'LOGIN_SMTP_URL', 'LOGIN_EMAIL_FROM', 'CUSTOMER_APP_URL', 'RATE_LIMIT_CUSTOMER_LOGIN_PER_MINUTE', 'COOKIE_SECURE', 'CUSTOMER_SESSION_TTL_DAYS', 'REVIEWER_API_KEY'];
const AVA = 'ava.brooks@example.com';

maybe('customer login: magic link routes (e2e, real Postgres)', () => {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  let app: INestApplication;
  let pool: Pool;
  let sent: { to: string; link: string }[];
  let failMail = false;
  const http = () => request(app.getHttpServer());

  const boot = async (env: Record<string, string> = {}) => {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    Object.assign(process.env, { RATE_LIMIT_CUSTOMER_LOGIN_PER_MINUTE: '100', ...LOGIN_ENV, ...env });
    sent = [];
    failMail = false;
    const fake = {
      sendLink: async (to: string, link: string) => { if (failMail) throw Object.assign(new Error(`550 ${to}`), { code: 'EENVELOPE' }); sent.push({ to, link }); },
      close: () => undefined,
    };
    app = (await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LOGIN_MAILER).useValue(fake).compile()).createNestApplication();
    configureApp(app);
    await app.init();
    pool = app.get(PG_POOL);
    await seedDatabase(pool);
  };
  const requestLink = async (email = AVA) => {
    const res = await http().post('/customer-auth/request').set(CSRF).send({ email });
    await app.get(CustomerAuthService).drain();
    return res;
  };
  const tokenOf = (link: string) => link.split('#token=')[1];
  const verify = (token: string) => http().post('/customer-auth/verify').set(CSRF).send({ token });
  /** Requests a link, redeems it, and returns the Cookie header. */
  const signIn = async (email = AVA) => {
    await requestLink(email);
    const res = await verify(tokenOf(sent.at(-1)!.link)).expect(200);
    return (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  };
  const as = (cookie: string) => ({ get: (p: string) => http().get(p).set('Cookie', cookie), post: (p: string) => http().post(p).set('Cookie', cookie).set(CSRF) });

  afterEach(async () => {
    await app?.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });
  afterAll(async () => {
    const cleanup = createPool(process.env.E2E_DATABASE_URL!);
    await seedDatabase(cleanup);
    await cleanup.end();
  });

  describe('request', () => {
    beforeEach(() => boot());

    it('answers the same 202 for a known and an unknown email, sets no cookie and shows no token; only the known one gets mail', async () => {
      const known = await requestLink(AVA).then((r) => r);
      const unknown = await requestLink('nobody@example.com');
      expect(known.status).toBe(202);
      expect(unknown.status).toBe(202);
      expect(known.body).toEqual({ status: 'sent' });
      expect(unknown.body).toEqual(known.body);
      expect(known.headers['set-cookie']).toBeUndefined();
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(AVA);
      expect(JSON.stringify(known.body)).not.toContain(tokenOf(sent[0].link));
    });

    it('matches the email in any case and with surrounding spaces; rejects a malformed email with 400', async () => {
      await requestLink('  AVA.BROOKS@Example.com ');
      expect(sent).toHaveLength(1);
      await http().post('/customer-auth/request').set(CSRF).send({ email: 'not-an-email' }).expect(400);
      await http().post('/customer-auth/request').set(CSRF).send({}).expect(400);
    });

    it('builds the link from CUSTOMER_APP_URL, never puts the token in a path or query, and keeps it out of the logs', async () => {
      await app.close();
      await boot({ CUSTOMER_APP_URL: 'https://shop.example.com/' });
      await requestLink();
      expect(sent[0].link).toMatch(/^https:\/\/shop\.example\.com\/login#token=[A-Za-z0-9_-]{43}$/);
    });

    it('needs the CSRF header', async () => {
      await http().post('/customer-auth/request').send({ email: AVA }).expect(403);
      await http().post('/customer-auth/verify').send({ token: 'x' }).expect(403);
      await http().post('/customer-auth/logout').expect(403);
      await http().post('/customer-auth/logout-all').expect(403);
    });

    it('is limited per client with 429 and Retry-After', async () => {
      await app.close();
      await boot({ RATE_LIMIT_CUSTOMER_LOGIN_PER_MINUTE: '3' });
      for (let i = 0; i < 3; i++) await requestLink('nobody@example.com');
      const blocked = await http().post('/customer-auth/request').set(CSRF).send({ email: AVA }).expect(429);
      expect(blocked.headers['retry-after']).toBeDefined();
    });

    it('creates at most 5 links per customer per hour but still answers 202 every time', async () => {
      for (let i = 0; i < 7; i++) expect((await requestLink()).status).toBe(202);
      expect(sent).toHaveLength(5);
      expect((await pool.query('SELECT count(*)::int AS n FROM login_links')).rows[0].n).toBe(5);
    });

    it('survives a mail failure: still 202, nothing thrown, no address in the log', async () => {
      failMail = true;
      const res = await requestLink();
      expect(res.status).toBe(202);
      expect(sent).toHaveLength(0);
      await http().get('/health').expect(200); // the process is fine
    });
  });

  describe('verify', () => {
    beforeEach(() => boot());

    it('sets a hardened cookie, returns the customer, and the link works once', async () => {
      await requestLink();
      const token = tokenOf(sent[0].link);
      const res = await verify(token).expect(200);
      expect(res.body).toEqual({ customer: { id: 1, name: 'Ava Brooks', email: AVA } });
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
      expect(cookie).toMatch(/^customer_session=[A-Za-z0-9_-]{43};/);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain(`Max-Age=${7 * 86400}`);
      expect(cookie).not.toContain('Secure');
      expect(cookie).not.toContain(token);
      expect(JSON.stringify(res.body)).not.toContain(token);
      await verify(token).expect(401);
    });

    it('marks the cookie Secure when configured', async () => {
      await app.close();
      await boot({ COOKIE_SECURE: 'true' });
      await requestLink();
      const res = await verify(tokenOf(sent[0].link)).expect(200);
      expect(res.headers['set-cookie'][0]).toContain('Secure');
    });

    it('turns one link into exactly one session even when eight requests race', async () => {
      await requestLink();
      const token = tokenOf(sent[0].link);
      await Promise.all(Array.from({ length: 6 }, () => pool.query('SELECT pg_sleep(0.05)')));
      const results = await Promise.all(Array.from({ length: 8 }, () => verify(token)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 401, 401, 401, 401, 401, 401, 401]);
      expect((await pool.query('SELECT count(*)::int AS n FROM customer_sessions')).rows[0].n).toBe(1);
    });

    it('answers every bad link with the same 401: unknown, empty, expired, used, superseded, huge, wrong type', async () => {
      await requestLink();
      const expired = tokenOf(sent[0].link);
      await pool.query(`UPDATE login_links SET expires_at = now() - interval '1 second'`);
      const bodies = [];
      for (const token of ['unknown-token-value', '', expired, 'x'.repeat(5000)]) bodies.push((await verify(token).expect(401)).body);
      await http().post('/customer-auth/verify').set(CSRF).send({ token: 42 }).expect(400); // not even a string: validation, reveals nothing
      for (const b of bodies) expect(b).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired link' });

      for (let i = 0; i < 3; i++) await requestLink(); // the third supersedes the oldest of the new ones
      const [oldest, , newest] = sent.slice(1).map((s) => tokenOf(s.link));
      await verify(oldest).expect(401);
      await verify(newest).expect(200);
    });
  });

  describe('sessions', () => {
    beforeEach(() => boot());

    it('/me returns the customer for a session and 401 otherwise', async () => {
      const cookie = await signIn();
      expect((await as(cookie).get('/customer-auth/me').expect(200)).body).toEqual({ customer: { id: 1, name: 'Ava Brooks', email: AVA } });
      await http().get('/customer-auth/me').expect(401);
      await http().get('/customer-auth/me').set('Cookie', 'customer_session=made-up').expect(401);
    });

    it('expires after the absolute lifetime and after 24 idle hours', async () => {
      const cookie = await signIn();
      await pool.query(`UPDATE customer_sessions SET last_seen_at = now() - interval '25 hours'`);
      await as(cookie).get('/customer-auth/me').expect(401);
      const fresh = await signIn();
      await as(fresh).get('/customer-auth/me').expect(200);
      await pool.query(`UPDATE customer_sessions SET expires_at = now() - interval '1 second'`);
      await as(fresh).get('/customer-auth/me').expect(401);
    });

    it('logout ends this session and clears the cookie; replaying it fails', async () => {
      const cookie = await signIn();
      const res = await as(cookie).post('/customer-auth/logout').expect(204);
      expect(res.headers['set-cookie'][0]).toMatch(/^customer_session=;/);
      await as(cookie).get('/customer-auth/me').expect(401);
      await as(cookie).post('/customer-auth/logout').expect(401);
    });

    it('logout-all ends every session of that customer and nobody else\'s', async () => {
      const [one, two, ben] = [await signIn(), await signIn(), await signIn('ben.carter@example.com')];
      await as(one).post('/customer-auth/logout-all').expect(204);
      await as(one).get('/customer-auth/me').expect(401);
      await as(two).get('/customer-auth/me').expect(401);
      await as(ben).get('/customer-auth/me').expect(200);
    });

    it('a full journey: sign in, start a chat, read it back, see it listed, sign out', async () => {
      const cookie = await signIn();
      const conv = (await as(cookie).post('/conversations').send({}).expect(201)).body;
      await as(cookie).post(`/conversations/${conv.id}/messages`).send({ content: 'Show my recent orders' }).expect(201);
      expect((await as(cookie).get(`/conversations/${conv.id}`).expect(200)).body.conversation.customerId).toBe(1);
      expect((await as(cookie).get('/my/conversations').expect(200)).body).toHaveLength(1);
      await as(cookie).post('/customer-auth/logout').expect(204);
      await as(cookie).get(`/conversations/${conv.id}`).expect(401);
    });

    it('conversations from before login mode appear after sign-in', async () => {
      const legacy = await app.get(PgAgentStore).createConversation(1, 'old');
      const cookie = await signIn();
      expect((await as(cookie).get('/my/conversations').expect(200)).body.map((c: { id: string }) => c.id)).toContain(legacy.id);
    });
  });

  describe('with login off', () => {
    it('the routes do not exist (404) and nothing is mailed', async () => {
      await boot({ CUSTOMER_LOGIN: 'false' });
      await http().post('/customer-auth/request').set(CSRF).send({ email: AVA }).expect(404);
      await http().post('/customer-auth/verify').set(CSRF).send({ token: 'x' }).expect(404);
      await http().post('/customer-auth/logout').set(CSRF).expect(404);
      await http().get('/customer-auth/me').expect(404);
      expect(sent).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run to see it fail.** `export E2E_DATABASE_URL=...; npm test -w apps/api -- test/customer-auth.e2e`. Expected: failures (every route 404).

- [ ] **Step 3: Implement.**

`dto.ts` (append):

```ts
export class RequestLinkDto {
  @trim() @IsEmail() @MaxLength(254)
  email!: string;
}

/** Only the type is checked here: every other problem with a token (empty, huge, unknown) is the same 401 from the service. */
export class VerifyLinkDto {
  @IsString()
  token!: string;
}
```
`rate-limit.ts`: import `loadCustomerLoginLimit` and add:

```ts
/** Asking for or redeeming a sign-in link: per client, so it says nothing about which emails exist. */
export const limitedCustomerLogin = () => Throttle({ default: { limit: () => loadCustomerLoginLimit(), ttl: seconds(60) } });
```
`http/login-enabled.guard.ts`:

```ts
import { type CanActivate, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../tokens';

/** The customer-auth routes exist only in login mode; otherwise they are as absent as before this feature. */
@Injectable()
export class LoginEnabledGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  canActivate(): boolean {
    if (!this.cfg.customerLogin.enabled) throw new NotFoundException();
    return true;
  }
}
```
`http/csrf-header.guard.ts`:

```ts
import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { hasCsrfHeader } from '../auth/csrf';

/**
 * Every non-read call on /customer-auth must come from our own page (a cross-origin page cannot add this header without
 * a CORS preflight). Needed even before sign-in: it stops a foreign page from triggering mail or planting a session.
 */
@Injectable()
export class CsrfHeaderGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (req.method === 'GET' || req.method === 'HEAD') return true;
    if (!hasCsrfHeader(req)) throw new ForbiddenException('Missing X-Requested-By header');
    return true;
  }
}
```
`http/customer-auth.controller.ts`:

```ts
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CustomerAuthService } from '../auth/customer-auth.service';
import { CUSTOMER_COOKIE, customerCookieOptions, readCookie } from '../auth/cookie';
import { customerOf, principalOf } from '../auth/principal';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../tokens';
import { CsrfHeaderGuard } from './csrf-header.guard';
import { CustomerGuard } from './customer.guard';
import { RequestLinkDto, VerifyLinkDto } from './dto';
import { LoginEnabledGuard } from './login-enabled.guard';
import { limitedCustomerLogin } from './rate-limit';

@Controller('customer-auth')
@UseGuards(LoginEnabledGuard, CsrfHeaderGuard)
export class CustomerAuthController {
  constructor(private readonly auth: CustomerAuthService, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** Always the same answer; mail goes out afterwards, and only to a real customer. */
  @Post('request')
  @HttpCode(202)
  @limitedCustomerLogin()
  async request(@Body() dto: RequestLinkDto) {
    await this.auth.requestLink(dto.email);
    return { status: 'sent' };
  }

  /** The link's token is redeemed here (not by a GET), so a mail scanner that merely fetches the page consumes nothing. */
  @Post('verify')
  @HttpCode(200)
  @limitedCustomerLogin()
  async verify(@Body() dto: VerifyLinkDto, @Res({ passthrough: true }) res: Response) {
    const { token, customer } = await this.auth.verify(dto.token);
    res.cookie(CUSTOMER_COOKIE, token, customerCookieOptions(this.cfg));
    return { customer };
  }

  @Get('me')
  @UseGuards(CustomerGuard)
  me(@Req() req: Request) {
    const { customerId, name, email } = customerOf(principalOf(req))!; // CustomerGuard guarantees a customer
    return { customer: { id: customerId, name, email } };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(CustomerGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = readCookie(req, CUSTOMER_COOKIE);
    if (token) await this.auth.logout(token);
    this.clear(res);
  }

  @Post('logout-all')
  @HttpCode(204)
  @UseGuards(CustomerGuard)
  async logoutAll(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logoutAll(customerOf(principalOf(req))!.customerId);
    this.clear(res);
  }

  private clear(res: Response) {
    const { maxAge: _maxAge, ...attrs } = customerCookieOptions(this.cfg); // same attributes as when it was set, so the browser matches it
    res.clearCookie(CUSTOMER_COOKIE, attrs);
  }
}
```
`agent.module.ts`: add `CustomerAuthController` to `controllers`.

- [ ] **Step 4: Run.** `export E2E_DATABASE_URL=...; npm test -w apps/api -- test/customer-auth.e2e test/customer-access`, then the whole API suite twice, then root `npm run typecheck`. Expected: all pass, no leaked-app or "torn down" messages in the output (if there are, a test booted a second app without closing the first).
- [ ] **Step 5: Mutation checks.** Remove the `used_at IS NULL` from `consumeLoginLink` (the race and single-use tests must fail), restore. Make `requestLink` `await` the delivery (the "answers before the mail is sent" unit test must fail), restore.
- [ ] **Step 6: Commit** `Add the customer sign-in link routes`. Ledger test command: `npm test -w apps/api`.

---

### Task 5: Web: sign-in form, landing page, "my conversations"

**Files:**
- Create: `apps/web/src/lib/login-fragment.ts` + `.test.ts`, `apps/web/src/lib/customer-view.ts` + `.test.ts`, `apps/web/src/components/CustomerSignIn.tsx`, `apps/web/src/app/login/page.tsx`
- Modify: `apps/web/src/lib/api.ts` (+ `api.test.ts`), `apps/web/src/lib/types.ts`, `apps/web/src/components/TopBar.tsx`, `apps/web/src/components/ConversationList.tsx`, `apps/web/src/app/page.tsx`, `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: the HTTP routes from Tasks 3-4; `/health.customerLogin`.
- Produces:
  ```ts
  // login-fragment.ts
  export function readLoginToken(hash: string): string | null;            // '#token=<43+ url-safe chars>' -> token
  // customer-view.ts
  export type CustomerScreen = 'loading' | 'demo' | 'sign-in' | 'chat';
  export function customerScreen(health: { customerLogin?: boolean } | null, me: unknown | null): CustomerScreen;
  // api.ts additions
  customerRequestLink(email): Promise<{ status: string }>; customerVerify(token): Promise<{ customer: CustomerMe }>;
  customerMe(): Promise<{ customer: CustomerMe }>; customerLogout(): Promise<null>; customerLogoutAll(): Promise<null>;
  myConversations(): Promise<MyConversation[]>; startMyConversation(): Promise<ConversationSummary>;
  // types.ts: CustomerMe { id; name; email }, MyConversation { id; title; createdAt; lastStatus: string | null; awaitingApproval: boolean }
  ```

- [ ] **Step 1: Read the framework docs.** Per `apps/web/AGENTS.md`, read `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-router.md` (and any page/client-component doc you need) before writing the landing page; use `useRouter` from `next/navigation`. State the Next.js version (16.4.2) in the ledger.
- [ ] **Step 2: Failing tests.**

`apps/web/src/lib/login-fragment.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readLoginToken } from './login-fragment';

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF1234';

describe('readLoginToken', () => {
  it('reads the token from the fragment the email link carries', () => {
    assert.equal(readLoginToken(`#token=${TOKEN}`), TOKEN);
  });

  it('returns null for anything else: no fragment, other keys, extra parts, odd characters, too short or too long', () => {
    for (const hash of ['', '#', '#token=', '#tok=abc', `#token=${TOKEN}&x=1`, `#token=${TOKEN}/`, '#token=short', `#token=${'a'.repeat(600)}`, `token=${TOKEN}`, '#token=has space-has space-has space']) {
      assert.equal(readLoginToken(hash), null, hash);
    }
  });
});
```
`apps/web/src/lib/customer-view.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { customerScreen } from './customer-view';

describe('customerScreen', () => {
  it('waits for health, then shows the old demo picker when login is off', () => {
    assert.equal(customerScreen(null, null), 'loading');
    assert.equal(customerScreen({ customerLogin: false }, null), 'demo');
    assert.equal(customerScreen({}, null), 'demo'); // an older API that does not say
  });

  it('asks for sign-in when login is on and nobody is signed in, and shows the chat once someone is', () => {
    assert.equal(customerScreen({ customerLogin: true }, null), 'sign-in');
    assert.equal(customerScreen({ customerLogin: true }, { id: 1 }), 'chat');
  });
});
```
Append to `api.test.ts`:

```ts
describe('api: customer login', () => {
  it('sends the CSRF header on every non-GET customer call and none on reads', async () => {
    const seen = stubFetch({});
    await api.customerRequestLink('ava@example.com');
    await api.customerVerify('tok');
    await api.customerLogout();
    await api.customerLogoutAll();
    await api.startMyConversation();
    for (const s of seen) assert.equal(header(s.init, 'x-requested-by'), 'reviewer-console', s.url);
    const reads = stubFetch([]);
    await api.customerMe();
    await api.myConversations();
    for (const s of reads) assert.equal(header(s.init, 'x-requested-by'), undefined, s.url);
  });

  it('starts a conversation with an empty body (the customer comes from the session) and posts the right paths', async () => {
    const seen = stubFetch({});
    await api.startMyConversation();
    await api.customerVerify('tok');
    assert.equal(seen[0].url, '/api/conversations');
    assert.deepEqual(JSON.parse(String(seen[0].init.body)), {});
    assert.equal(seen[1].url, '/api/customer-auth/verify');
    assert.deepEqual(JSON.parse(String(seen[1].init.body)), { token: 'tok' });
  });

  it('handles the empty 204 replies of logout', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    await assert.doesNotReject(api.customerLogout());
    await assert.doesNotReject(api.customerLogoutAll());
  });
});
```
Run `npm test -w apps/web`. Expected: failures (modules and methods missing).

- [ ] **Step 3: Implement the libs.**

`login-fragment.ts`:

```ts
const TOKEN = /^[A-Za-z0-9_-]{20,512}$/;

/** Reads `#token=<value>` from a URL fragment; null when it is absent or not shaped like a token. */
export function readLoginToken(hash: string): string | null {
  const match = /^#token=([^&]*)$/.exec(hash);
  return match && TOKEN.test(match[1]) ? match[1] : null;
}
```
`customer-view.ts`:

```ts
export type CustomerScreen = 'loading' | 'demo' | 'sign-in' | 'chat';

/** Which customer-page screen to show, from /health and the result of /customer-auth/me. */
export function customerScreen(health: { customerLogin?: boolean } | null, me: unknown | null): CustomerScreen {
  if (health === null) return 'loading';
  if (!health.customerLogin) return 'demo';
  return me === null ? 'sign-in' : 'chat';
}
```
`types.ts` additions:

```ts
/** The signed-in customer (login mode). */
export interface CustomerMe { id: number; name: string; email: string }

/** A customer's own conversation list entry (login mode): no token usage, no reviewer counts. */
export interface MyConversation { id: string; title: string; createdAt: string; lastStatus: string | null; awaitingApproval: boolean }
```
`api.ts`: import `CustomerMe, MyConversation`; change the health type to `{ status: string; provider: string; reviewerAuth: boolean; reviewerAccounts: boolean; customerLogin?: boolean }`; add to `api`:

```ts
  // customer login (cookie session; the CSRF header comes from call())
  customerRequestLink: (email: string) => call<{ status: string }>('/customer-auth/request', post({ email })),
  customerVerify: (token: string) => call<{ customer: CustomerMe }>('/customer-auth/verify', post({ token })),
  customerMe: () => call<{ customer: CustomerMe }>('/customer-auth/me'),
  customerLogout: () => call<null>('/customer-auth/logout', { method: 'POST' }),
  customerLogoutAll: () => call<null>('/customer-auth/logout-all', { method: 'POST' }),
  myConversations: () => call<MyConversation[]>('/my/conversations'),
  startMyConversation: () => call<ConversationSummary>('/conversations', post({})),
```
Run `npm test -w apps/web`. Expected: pass.

- [ ] **Step 4: Components.**

`apps/web/src/components/CustomerSignIn.tsx`:

```tsx
import { useState } from 'react';
import { api } from '@/lib/api';

/** Asks for a sign-in link. The answer is the same for every email, so the page never says whether one is registered. */
export function CustomerSignIn() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.customerRequestLink(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the link');
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="panel login-card">
        <h1>Check your inbox</h1>
        <p className="muted">If that email belongs to a customer account, a sign-in link is on its way. It works once and expires in 15 minutes.</p>
        <button className="btn" onClick={() => setSent(false)}>Use a different email</button>
      </div>
    );
  }
  return (
    <form className="panel login-card" onSubmit={submit}>
      <h1>Sign in</h1>
      <p className="muted">Enter your account email and we will send you a one-time sign-in link.</p>
      <input type="email" aria-label="Email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
      {error && <div className="notice err" role="alert">{error}</div>}
      <button className="btn primary" disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Send me a sign-in link'}</button>
    </form>
  );
}
```
`TopBar.tsx`: make `onChangePassword` optional and add an optional `onLogoutAll`:

```tsx
export interface TopBarAccount { name: string; onLogout: () => void; onChangePassword?: () => void; onLogoutAll?: () => void }
```
and in the JSX replace the two buttons with:

```tsx
            {account.onChangePassword && <button className="link-btn" onClick={account.onChangePassword}>Change password</button>}
            {account.onLogoutAll && <button className="link-btn" onClick={account.onLogoutAll}>Sign out everywhere</button>}
            <button className="link-btn" onClick={account.onLogout}>Log out</button>
```
`ConversationList.tsx`: add an optional prop `onNew?: () => void` (login mode) and render, instead of the form, a single button when it is given:

```tsx
  /** Login mode: the customer comes from the session, so there is nothing to pick or type. */
  onNew?: () => void;
```
In the component: destructure `onNew`; render before the `{onCreate && (...)}` block:

```tsx
      {onNew && (
        <div className="new-chat"><button className="btn primary" onClick={onNew}>New conversation</button></div>
      )}
```
`login/page.tsx` (client page, the token is read once and removed from the address bar before anything else):

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { readLoginToken } from '@/lib/login-fragment';

/** Landing page of the emailed link: redeems the token from the fragment, then goes to the chat. */
export default function LoginPage() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const started = useRef(false); // development double-mounts effects, and a link works only once

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = readLoginToken(window.location.hash);
    history.replaceState(null, '', window.location.pathname); // the token leaves the address bar first
    if (!token) { setFailed(true); return; }
    api.customerVerify(token).then(() => router.replace('/')).catch(() => setFailed(true));
  }, [router]);

  return (
    <div className="app login">
      <div className="panel login-card">
        {failed ? (
          <>
            <h1>This link did not work</h1>
            <p className="muted">It may have expired or already been used. Request a new one.</p>
            <button className="btn primary" onClick={() => router.replace('/')}>Back to sign in</button>
          </>
        ) : (
          <h1>Signing you in…</h1>
        )}
      </div>
    </div>
  );
}
```
Append to `globals.css`: `.new-chat .btn { width: 100%; }`.

- [ ] **Step 5: The customer page.** Modify `apps/web/src/app/page.tsx`. Keep every existing line of demo-mode behaviour; add login mode alongside it:
  1. Imports: add `CustomerSignIn`, `customerScreen`, and types `CustomerMe, MyConversation`.
  2. State: `const [health, setHealth] = useState<{ customerLogin?: boolean } | null>(null); const [me, setMe] = useState<CustomerMe | null>(null); const [myChats, setMyChats] = useState<MyConversation[]>([]);` and `const loginMode = health?.customerLogin === true;`
  3. Mount effect: after `api.health()` resolves with `h`, `setProvider(h.provider)`; then `if (h.customerLogin) { const who = await api.customerMe().then((r) => r.customer).catch(() => null); setMe(who); if (who) setMyChats(await api.myConversations().catch(() => [])); } else { setChats(loadChats()); api.customers({}).then(setCustomers).catch(() => setCustomers([])); }` and finally `setHealth(h)` (set `me` and `health` together so the sign-in form never flashes for a signed-in customer). Keep the `.catch(() => setProvider('offline'))`.
  4. `chats`: in login mode derive them from `myChats`: `const chats: StoredConversation[] = loginMode ? myChats.map((c) => ({ id: c.id, token: '', customerName: me?.name ?? '', createdAt: c.createdAt })) : storedChats;` (rename the existing `chats` state to `storedChats`/`setStoredChats`). Define `const authFor = (c: StoredConversation) => (loginMode ? {} : { token: c.token });` and use it in `api.conversation`, `api.send` and the `useEventStream` target instead of `{ token: selected.token }`.
  5. `start`: add a login-mode branch used by `onNew`:

```tsx
  const startMine = async () => {
    try {
      const c = await api.startMyConversation();
      setMyChats(await api.myConversations());
      select(c.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null); else setError(message(e));
    }
  };
```
  6. A 401 from `refresh`/`send` in login mode: `if (loginMode && e instanceof ApiError && e.status === 401) { setMe(null); setSelectedId(null); setDetail(null); return; }` (import `ApiError`).
  7. Sign-out: `const signOut = async (everywhere: boolean) => { await (everywhere ? api.customerLogoutAll() : api.customerLogout()).catch(() => undefined); setMe(null); setSelectedId(null); setDetail(null); setMyChats([]); };`
  8. `summaries` in login mode: `myChats.map((c) => ({ id: c.id, customerName: me?.name ?? '', createdAt: c.createdAt, customerId: 0, customerEmail: '', title: c.title, lastStatus: c.lastStatus, pendingApprovals: c.awaitingApproval ? 1 : 0 }))`.
  9. Render: `const screen = customerScreen(health, me);` `if (screen === 'loading') return <div className="app" />;` `if (screen === 'sign-in') return (<div className="app login"><TopBar provider={provider} mode="customer" /><CustomerSignIn /></div>);` otherwise the existing layout, with `TopBar` given `account={loginMode && me ? { name: me.name, onLogout: () => void signOut(false), onLogoutAll: () => void signOut(true) } : null}` and `ConversationList` given `onNew={loginMode ? () => void startMine() : undefined}` and, in login mode, **not** `customers`/`onCreate`.
  10. Poll/refresh: after a send or an SSE signal in login mode also refresh the list (`setMyChats(await api.myConversations())`) so the awaiting-approval chip updates; do it inside the existing `refresh` when `loginMode`.

- [ ] **Step 6: Check.** `npm run typecheck`, `npm test -w apps/web`, `npm run build` (retry once on a first-run Next error; do not run `next upgrade`). Expected: all pass.
- [ ] **Step 7: Manual browser check (throwaway database only).** Use the test database on port 5435 and ports 3100/3101; never port 3000/3001 or the dev database. (a) `export DATABASE_URL=postgres://postgres:postgres@localhost:5435/aiagent_test; npm run -s seed -w apps/api; REVIEWER_PASSWORD='correct horse battery' npm run -s reviewer:add -w apps/api -- --email admin@example.com --name Admin`. (b) Build the API (`npm run build`), start it: `cd apps/api && API_PORT=3101 CUSTOMER_LOGIN=true LOGIN_SMTP_URL=smtp://localhost:1025 LOGIN_EMAIL_FROM=support@example.com CUSTOMER_APP_URL=http://localhost:3100 LLM_PROVIDER=mock MOCK_DELAY_MS=0 node dist/main` in the background, and the web app `cd apps/web && API_URL=http://localhost:3101 npx next dev -p 3100` in the background. There is no mail server, so mint the link by hand: `TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")`; compute `HASH=$(node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$TOKEN")`; `docker exec ai-agent-starter-db-1 psql -U postgres aiagent_test -c "INSERT INTO login_links (customer_id, token_hash, expires_at) VALUES (1, '$HASH', now() + interval '15 minutes')"`. (c) With the Chrome tools: open `http://localhost:3100/` (expect the sign-in form), request a link for any email (expect "Check your inbox"; the API logs a mail failure, no address), open `http://localhost:3100/login#token=$TOKEN` (expect the fragment to vanish from the address bar and the chat to load as Ava Brooks), start a conversation, send `Show my recent orders`, reload (still signed in), "Log out" (back to the form). Also open the same link again (expect "This link did not work"). (d) Stop both servers (verify the PIDs belong to this session before killing), reseed the test database, close the tab. Record exactly what was and was not checked; the real SMTP leg is not checked.
- [ ] **Step 8: Commit** `Add customer sign-in, the login landing page and the customer's conversation list to the web app`. Ledger test command: `npm test -w apps/web`.

---

### Task 6: Docs, TODO and the spec amendments

**Files:** Modify `README.md`, `TODO.md`, `.env.example` (only if Task 1 missed something), `docs/superpowers/specs/2026-10-31-customer-login-design.md`, `MEMORY.md` (untracked; update but do not `git add` it).

- [ ] **Step 1: Spec amendments (the code is the source of truth; record what was built).** In section 6 of the spec replace the "Resolution order" bullet with: "Resolution order in login mode: a reviewer principal that is a signed-in reviewer or the shared key wins; otherwise (anonymous, or the open demo) a valid customer session makes the caller a customer. The open demo therefore does not hide a customer session, and a customer on an open demo has no reviewer access there." In section 6's `POST /conversations` bullet add: "`CreateConversationDto` no longer requires `customerId`/`email` in the DTO; with login off the controller still answers `400` when neither is given." In section 3 add to **Verify**: "A `token` that is not a string is `400` (validation); every string problem is the `401`."
- [ ] **Step 2: README.** Add a "Customer login" section after "Accounts and four-eyes":

```markdown
## Customer login

Optional (`CUSTOMER_LOGIN=true`). Without it nothing changes: anyone can start a conversation as a customer, and a conversation is protected by its token (see Security notes). With it, a customer proves who they are by email, and a conversation belongs to that verified customer.

| `CUSTOMER_LOGIN` | A conversation is reached with | A conversation is started by |
| --- | --- | --- |
| unset / `false` | its token, or a reviewer | a body `customerId` or `email` |
| `true` | the session of the customer it belongs to, or a reviewer | the signed-in customer (a body `customerId` or `email` is `400`) |

**Flow.** The customer enters their email; `POST /customer-auth/request` always answers `202` (it says nothing about whether the email is a customer). If it is one, a one-time link is mailed to it (the mail is sent after the response). The link is `<CUSTOMER_APP_URL>/login#token=...`: the token is in the fragment, so it never reaches a server log or a `Referer`, and the landing page removes it from the address bar. The page redeems it with `POST /customer-auth/verify`, which sets the `customer_session` cookie (`HttpOnly`, `SameSite=Strict`, `Secure` under `COOKIE_SECURE`, `CUSTOMER_SESSION_TTL_DAYS` absolute, 24 idle hours). Links last 15 minutes and work once; at most 5 are created per customer per hour and only the 2 newest unused ones stay valid; every failure to redeem one is the same `401`. Only the SHA-256 of a link or session token is stored. Mutations authenticated by the cookie (and both unauthenticated `/customer-auth` POSTs) need the `X-Requested-By: reviewer-console` header.

**Access.** A conversation is readable, writable and streamable only by the customer it belongs to (or a reviewer); another customer, an anonymous caller and an unknown id all get the same `401`. `GET /my/conversations` lists the caller's own, including ones created before login mode. A customer is never a reviewer: `/approvals`, `/customers`, `/events` and the other reviewer routes are `401` for them, and their view of a conversation omits the policy, notification and four-eyes fields. In login mode conversation tokens are no longer accepted, and the open demo (no reviewer, no key) does not let an anonymous caller into conversations (reviewer routes stay open there, and the API warns at startup). If both a reviewer cookie and a customer cookie are present, the reviewer wins.

**Mail.** Set `LOGIN_SMTP_URL` and `LOGIN_EMAIL_FROM` (checked like the notification SMTP settings: remote hosts need STARTTLS, no credentials in other URLs, nothing is logged). Login mode refuses to start without them. This sender is separate from the reviewer notification channel, which must carry no customer data.

Limits: the link is as safe as the customer's mailbox; a stolen session cookie is that customer's session until it expires or they sign out; a nuisance caller can use up a customer's hourly link allowance; no sign-up, passwords, MFA or SSO; failed mail is logged, not retried; the real SMTP leg has not been exercised against a live mail server (tests use nodemailer's JSON transport).
```
Also: add the routes to the API table (`POST /customer-auth/request`, `POST /customer-auth/verify`, `POST /customer-auth/logout`, `POST /customer-auth/logout-all`, `GET /customer-auth/me`, `GET /my/conversations`, and `customerLogin` in the `/health` row); add the six variables (`CUSTOMER_LOGIN`, `LOGIN_SMTP_URL`/`LOGIN_EMAIL_FROM`, `CUSTOMER_APP_URL`, `CUSTOMER_SESSION_TTL_DAYS`, `RATE_LIMIT_CUSTOMER_LOGIN_PER_MINUTE`) to the Configuration table with their defaults; replace the Security-notes bullet "**Still not solved: who may start a conversation.**" with a bullet saying that with `CUSTOMER_LOGIN=true` the customer comes from a verified session, and without it the original caveat stands; add a Testing bullet (unit: token/link lifecycle, principals, mail; e2e: cross-customer access, single use under a race, uniform answers, CSRF, modes; web: the fragment reader, the screen helper, the CSRF header) and the Known-limitations lines from the spec; in "Next steps" delete the customer-login mention. Verify every claim against the code and tests before writing it; do not claim a browser check beyond what Task 5 Step 7 recorded.
- [ ] **Step 3: TODO and memory.** In `TODO.md` tick `4.5b` and `4.5` (`- [x] 4.5 ...`, `  - [x] 4.5b Customer login (email magic link)`). Update `MEMORY.md`: focus line (4.5 implemented; both parts on `phase-4-accounts`, not merged), a decision line for login mode (opt-in, session replaces tokens, customer never a reviewer, demo does not open conversations in login mode), and remove "No customer login" from the verified limitations (keep the caveat for login-off).
- [ ] **Step 4: Verify.** Root `npm run typecheck`; `npm test` with `E2E_DATABASE_URL` (record suites/tests counts, none skipped); `npm run build`. Fix any README claim the code does not support.
- [ ] **Step 5: Commit** `Document customer login; tick 4.5 in TODO` (add `README.md TODO.md docs .env.example`, not `MEMORY.md`). Ledger test command: `npm test`.
