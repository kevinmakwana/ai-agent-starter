# Reviewer Accounts and Four-Eyes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each reviewer their own login (email + password, server session cookie) so every decision names a person, and let operators require two different reviewers for high-value refunds and cancellations.

**Architecture:** A global middleware resolves a *principal* (`demo | key | reviewer | none`) per request from the session cookie, the shared key, or neither; guards, controllers and the SSE streams read `req.principal` instead of calling the key check directly. Sessions are rows (only a SHA-256 of the cookie token is stored). Four-eyes adds `approvals_required` to actions and a row-locked `approveStep` transaction in the store that records each reviewer's approval and executes only when the count of distinct active approvers reaches the requirement.

**Tech Stack:** NestJS 11, `pg`, Node `crypto.scrypt`, Express cookies (no new dependency), Next.js 16 proxy, Jest 30, `node:test` for web.

**Spec:** `docs/superpowers/specs/2026-10-29-reviewer-accounts-four-eyes-design.md` (the binding authority; read it fully, including sections 1, 3, 4 and 5).

## Global Constraints

- Branch `phase-4-accounts` (off `main` after PRs #10-#14). Never push or merge; the controller handles that.
- e2e tests run ONLY against `E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5435/aiagent_test` (container `ai-agent-starter-db-1`; it re-seeds). Never touch other ports or other projects' containers (the repo `.env` `DB_PORT=5433` belongs to another project). Jest runs `maxWorkers: 1`.
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Demo mode (no reviewers, no key) and key mode (key, no reviewers) behave exactly as today; every existing test passes unchanged except where this plan names a change.
- Secrets: no password, password hash, session token, token hash, `failed_attempts` or `locked_until` ever appears in a response, a log line, an error message or a test snapshot. Login failures are one uniform `401 Invalid email or password`.
- Passwords: scrypt (N=2^15, r=8, p=1, 64-byte key, 16-byte salt), stored `scrypt$N$r$p$<salt b64>$<hash b64>`, min 12 / max 200 characters, `timingSafeEqual`, dummy verification for unknown emails.
- Sessions: 32 random bytes base64url cookie value; DB stores SHA-256 only; absolute `SESSION_TTL_HOURS` (default 12) and 30 minutes idle; new token at every login; cookie `reviewer_session`, `HttpOnly; SameSite=Strict; Path=/`, `Secure` when `COOKIE_SECURE=true` (default true if `NODE_ENV=production`).
- CSRF: cookie-authenticated requests other than GET/HEAD need header `X-Requested-By: reviewer-console`, else 403.
- Lockout: 5 consecutive failures lock the account 15 minutes (still uniform 401); login route has its own limit `RATE_LIMIT_LOGIN_PER_MINUTE` (default 10) using the repo's existing rate-limit helper pattern (`apps/api/src/http/rate-limit.ts`).
- Four-eyes: `FOUR_EYES_REFUND_OVER` (dollars, `amount > value`; unset/0 = off), `FOUR_EYES_CANCELLATIONS` (`true|false`, default false, other values are a startup error). The count is fixed when the action is parked. One reject rejects. Key/demo callers cannot give approvals on 2-approval actions (409 `FOUR_EYES_NEEDS_ACCOUNTS`).
- Match surrounding style (comment density, naming, small focused files). Do not run `next upgrade`.
- Library docs: use the Context7 MCP tools for any NestJS/Express/Next.js API you are unsure about, and say which version the docs were for.

## Review Focus

- Cookie/session abuse: a stolen or replayed token after logout, deactivation, password change or expiry must fail; session fixation (new token per login); CSRF on every mutating cookie route including `POST /approvals/:id` and `/auth/*`.
- Login: user enumeration by timing or message; lockout counters under concurrent attempts; unknown vs inactive vs locked all identical.
- Two reviewers approving at the same instant must execute exactly once; the same reviewer sending two approvals concurrently must not satisfy four-eyes alone; a reviewer deactivated between the two approvals must not count.
- Mode switching: creating the first reviewer switches a running API to accounts mode (cache invalidation); the shared key must stop working then; demo/key mode unchanged.
- SSE: `/events` and `/conversations/:id/events` authenticate with the cookie only in accounts mode; customers still use their conversation token; nothing leaks `approvalsGiven`/`approvedBy` to customers.
- Admin safety: last active admin cannot be deactivated/demoted; non-admins get 403 on admin routes; no hash in any reviewer response.

---

### Task 1: Passwords, configuration and schema

**Files:**
- Create: `apps/api/src/auth/password.ts`, `apps/api/src/auth/password.spec.ts`
- Modify: `apps/api/src/config.ts` (+ `config.spec.ts`), `apps/api/src/agent/policy.ts` (config type only), `apps/api/src/db/schema.ts`, `.env.example`

**Interfaces:**
- Produces:
  ```ts
  export const MIN_PASSWORD = 12; export const MAX_PASSWORD = 200;
  export function hashPassword(plain: string): Promise<string>;           // throws on length violations
  export function verifyPassword(plain: string, stored: string): Promise<boolean>; // false for malformed `stored`; never throws on bad input
  export function dummyVerify(plain: string): Promise<void>;              // burns equivalent time for unknown emails
  ```
  `AppConfig` gains: `auth: { sessionTtlHours: number; cookieSecure: boolean; loginPerMinute: number }`, and `approvalPolicy.fourEyes: { refundOver: number; cancellations: boolean }` (extend `ApprovalPolicyConfig`).

- [ ] **Step 1: Failing tests** `password.spec.ts`: hash format `scrypt$32768$8$1$...`; two hashes of one password differ; verify true/false; verify rejects tampered parameters and truncated/garbage strings with `false` (no throw); `hashPassword` rejects < 12 and > 200 chars; `dummyVerify` resolves; a hash with different N still verifies (parameters are read from the string). `config.spec.ts`: defaults (`sessionTtlHours` 12, `cookieSecure` false unless `NODE_ENV=production` or `COOKIE_SECURE=true`, `loginPerMinute` 10); validation of each (`SESSION_TTL_HOURS` positive int, `COOKIE_SECURE` `true|false`, `RATE_LIMIT_LOGIN_PER_MINUTE` positive int); `FOUR_EYES_REFUND_OVER` via the existing dollar parser (0/unset = off), `FOUR_EYES_CANCELLATIONS` accepts `true`/`false` only (e.g. `yes` throws naming the variable).
- [ ] **Step 2: Run to see failures:** `npx jest src/auth src/config.spec.ts` in `apps/api`.
- [ ] **Step 3: Implement** `password.ts` with `node:crypto` `scrypt` (promisified, `maxmem` raised to cover N=2^15: 128 * N * r * 2), constant-time comparison, and config parsing. Keep existing `loadConfig` behaviour for every other variable.
- [ ] **Step 4: Schema** (`SCHEMA_SQL`, idempotent, placed after the existing actions/approval_events DDL):
  ```sql
  CREATE TABLE IF NOT EXISTS reviewers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE CHECK (email = lower(email)),
    name text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('admin', 'reviewer')),
    active boolean NOT NULL DEFAULT true,
    failed_attempts int NOT NULL DEFAULT 0,
    locked_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
  );
  CREATE TABLE IF NOT EXISTS reviewer_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    reviewer_id uuid NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reviewer_sessions_reviewer_idx ON reviewer_sessions (reviewer_id);
  ALTER TABLE actions ADD COLUMN IF NOT EXISTS approvals_required int NOT NULL DEFAULT 1 CHECK (approvals_required IN (1, 2));
  CREATE TABLE IF NOT EXISTS action_approvals (
    action_id uuid NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
    reviewer_id uuid NOT NULL REFERENCES reviewers(id),
    note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (action_id, reviewer_id)
  );
  ALTER TABLE approval_events DROP CONSTRAINT IF EXISTS approval_events_kind_check;
  ALTER TABLE approval_events ADD CONSTRAINT approval_events_kind_check
    CHECK (kind IN ('requested', 'auto_approved', 'first_approval', 'approved', 'rejected', 'expired'));
  ```
  Add `reviewers`, `reviewer_sessions`, `action_approvals` to `RESET_SQL` (order-insensitive with `CASCADE`). Update the `ApprovalEventKind` type to include `'first_approval'` and widen any exhaustive switch (typecheck will find them; the web `AuditLog`/types too, with a plain label "First approval" and no behaviour change yet). `.env.example`: add the new variables, commented, in neighbouring style.
- [ ] **Step 5: Run** the specs, root `npm run typecheck`, and (with `E2E_DATABASE_URL`) the existing e2e suites to prove the DDL applies on top of an existing database. Expected: pass.
- [ ] **Step 6: Commit** `Add password hashing, account settings and the reviewer schema`.

---

### Task 2: Reviewer store, sessions and the principal pipeline

**Files:**
- Create: `apps/api/src/auth/reviewer.store.ts` (Postgres), `apps/api/src/auth/auth.service.ts`, `apps/api/src/auth/principal.ts`, `apps/api/src/auth/principal.middleware.ts`, `apps/api/src/auth/csrf.ts`; specs for each (`*.spec.ts`)
- Modify: `apps/api/src/http/reviewer.guard.ts`, `conversation-access.guard.ts`, `conversations.controller.ts`, `events.controller.ts`, `health.controller.ts`, `apps/api/src/agent/agent.module.ts` (providers + `configure(consumer)`), `apps/api/src/http/setup.ts` only if needed, existing `reviewer.guard.spec.ts`

**Interfaces:**
- Consumes: `hashPassword`, `verifyPassword`, `dummyVerify`, config (Task 1).
- Produces:
  ```ts
  export type Principal =
    | { kind: 'demo' } | { kind: 'key' }
    | { kind: 'reviewer'; id: string; email: string; name: string; role: 'admin' | 'reviewer' }
    | { kind: 'none' };
  declare module 'express-serve-static-core' { interface Request { principal: Principal } }
  export const isReviewerPrincipal = (p: Principal): boolean => p.kind !== 'none';
  // ReviewerStore (Postgres): createReviewer, findByEmail, findById, listReviewers, updateReviewer, countActiveAdmins,
  //   hasAnyReviewer (cached ~5 s, invalidated by createReviewer), recordLoginFailure/Success (lockout counters),
  //   createSession, resolveSession (token hash -> reviewer if active and not expired/idle; refreshes last_seen at most 1/min),
  //   deleteSession, deleteSessionsForReviewer, deleteExpired
  // AuthService: login(email, password, ctx) -> { token, reviewer } | throws uniform UnauthorizedException; logout; changePassword;
  //   resolvePrincipal(req): Promise<Principal>
  ```
  Cookie helpers: `readCookie(req, name)`, `sessionCookieOptions(cfg)`. CSRF helper: `csrfOk(req, principal)`.

- [ ] **Step 1: Failing unit tests** (with an in-memory fake `ReviewerStore`): principal resolution table (modes from the spec's section 1: none/none → demo; key set + no reviewers → key via Bearer else none; reviewers exist → only a valid cookie, the key is ignored); expired and idle sessions rejected; deactivated reviewer's session rejected; lockout after 5 failures (6th attempt with the right password still fails until `locked_until` passes; success resets); unknown email calls `dummyVerify`; CSRF rule (cookie principal + POST without header → false; with header → true; GET → true; key/demo → true); cookie parsing edge cases (multiple cookies, encoded values, missing). Update `reviewer.guard.spec.ts` to the principal-based guard while keeping its existing expectations for demo/key modes.
- [ ] **Step 2: Implement** the store, service, middleware, guards. `ReviewerGuard` and `ConversationAccessGuard` read `req.principal` (the middleware runs first for all routes via `AgentModule.configure`); `ReviewerGuard` throws 401 for `none` and 403 when a cookie request fails CSRF; `ConversationAccessGuard` allows any non-`none` principal or a valid conversation token; `ConversationsController.isReviewer(req)` and the event streams use the principal. Keep the old `isReviewer(key, authorization)` helper exported (used by the middleware for key mode). `GET /health` adds `reviewerAccounts: boolean` (from `hasAnyReviewer`) and keeps `reviewerAuth` true for key or accounts mode. Log the startup warning when accounts mode is active and `REVIEWER_API_KEY` is set (once, at first detection).
- [ ] **Step 3: Store e2e** (`apps/api/test/reviewer-store.e2e-spec.ts`): create/find, unique lowercased email, session create/resolve/expire (manipulate `expires_at`/`last_seen_at` in SQL), deactivation hides the session, `deleteSessionsForReviewer`, lockout counters under 10 concurrent failures end at a consistent state, `hasAnyReviewer` flips true after `createReviewer`.
- [ ] **Step 4: Run** unit specs, the new e2e, the full API suite and root `npm run typecheck`. Existing demo/key mode tests must pass unchanged.
- [ ] **Step 5: Commit** (two commits fine): `Add the reviewer store and sessions`, `Resolve a principal per request and use it in guards, streams and health`.

---

### Task 3: Auth and admin HTTP routes, first-admin command

**Files:**
- Create: `apps/api/src/http/auth.controller.ts`, `apps/api/src/http/reviewers.controller.ts`, `apps/api/src/http/admin.guard.ts`, `apps/api/src/cli/reviewer-add.ts`, `apps/api/test/auth.e2e-spec.ts`
- Modify: `apps/api/src/http/dto.ts`, `apps/api/src/agent/agent.module.ts` (controllers), `apps/api/package.json` (`reviewer:add` script), `apps/api/src/http/setup.ts` only if CORS headers need `x-requested-by`

**Interfaces:**
- Consumes: `AuthService`, `ReviewerStore`, principal pipeline (Task 2).
- Produces: routes `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/password`; admin `GET /reviewers`, `POST /reviewers`, `PATCH /reviewers/:id`; `ReviewerView = { id, email, name, role, active, createdAt, lastLoginAt }` (never hashes/counters); CLI `npm run reviewer:add -w apps/api -- --email … --name …`.

- [ ] **Step 1: DTOs** with `class-validator` (the repo uses `whitelist` + `forbidNonWhitelisted`): login `{ email (isEmail, max 254), password (string, max 200) }`, change-password `{ current, next }`, create `{ email, name (1-100), role, password }`, update `{ name?, role?, active?, password? }`. Passwords are never echoed in validation errors (check the 400 body).
- [ ] **Step 2: Controllers.** Login sets the cookie (`res.cookie` with the spec's options, `maxAge` = absolute TTL) and returns `{ reviewer }`; wrap with the login rate limit from `rate-limit.ts` (`loginPerMinute`). Logout needs the cookie principal (CSRF applies), deletes the session, clears the cookie. `/auth/me` returns the reviewer or 401. `POST /auth/password` verifies `current`, enforces length rules, deletes all OTHER sessions of the reviewer, keeps the current one. Admin routes behind `ReviewerGuard` + `AdminGuard` (principal must be `reviewer` with role `admin`; key/demo principals are 403 here because there is no identity); `PATCH` that deactivates, demotes or resets a password deletes that reviewer's sessions; refuse (409 `LAST_ADMIN`) to deactivate/demote the last active admin; duplicate email on create is 409. Log admin actions with `Logger('Reviewers')` (actor id, target id, action; never passwords).
- [ ] **Step 3: CLI** `reviewer-add.ts`: parse `--email --name` (and optional `--role`, default `admin`), read the password from `REVIEWER_PASSWORD` or, on a TTY, prompt twice without echo; never accept it as a flag (error if a `--password` flag is present); apply the schema, connect with `loadRootEnv`/`loadConfig().databaseUrl`, create the reviewer, print only email and id. Exit non-zero with a clear message if the email exists or the password is too short.
- [ ] **Step 4: e2e** `auth.e2e-spec.ts` (boot pattern as in `approval-flow.e2e-spec.ts`; create reviewers through the store; restore `process.env`; close apps in `afterEach`): login/me/logout with cookie attributes asserted (`HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` only when configured); uniform 401 body for unknown/wrong/inactive/locked; lockout after 5 failures; login rate limit 429; session expiry and idle timeout (SQL time travel); deactivation and password change end sessions (change keeps the current one); CSRF header required on `POST /auth/logout`, `POST /approvals/:id` and admin mutations with a cookie and NOT required with the shared key in key mode; the shared key is ignored once a reviewer exists (a previously valid Bearer key now gets 401 on `/approvals`); `/events` SSE opens with the cookie in accounts mode and 401s without; a customer token still works on its own conversation; admin routes 403 for non-admins and for key/demo principals; last-admin protection; no `password_hash`/`failed_attempts`/token anywhere in any response body (JSON-stringify and grep); 400 bodies for invalid input do not echo passwords.
- [ ] **Step 5: CLI test** (unit, with the pure parts factored out): flag parsing, refusal of `--password`, password length errors.
- [ ] **Step 6: Run** the new specs, the whole API suite, root `npm run typecheck`. Commit `Add login, logout, admin routes and the first-admin command`.

---

### Task 4: Four-eyes and named audit actors

**Files:**
- Modify: `apps/api/src/agent/policy.ts` (+ spec), `apps/api/src/agent/types.ts`, `apps/api/src/agent/runner.ts` (+ `runner.spec.ts`), `apps/api/test/fakes.ts`, `apps/api/src/db/pg-agent.store.ts`, `apps/api/src/http/approvals.controller.ts`, `apps/api/src/http/run-view.ts`, `apps/api/src/http/dto.ts` if needed, `apps/api/src/agent/agent.module.ts` (pass principal-aware options if needed)
- Create: `apps/api/test/four-eyes.e2e-spec.ts`; extend `apps/api/test/audit-log.e2e-spec.ts` for names

**Interfaces:**
- Consumes: reviewers schema (Task 1), principal on the request (Task 2).
- Produces:
  ```ts
  // policy: evaluateApproval(...) now also returns approvalsRequired: 1 | 2
  // types: Action gains approvalsRequired: number; ApprovalView gains approvalsGiven: number, approvedBy: string[] (names)
  // ApprovalEvent gains actorName: string | null; DecisionAudit gains actorId?: string; ApprovalEventKind gains 'first_approval'
  // store: approveStep(actionId, reviewer: { id: string }, note?): Promise<{ action: Action; final: boolean } | null>   // null = not pending
  //        errors: ConflictError code ALREADY_APPROVED_BY_YOU
  // runner.decide(actionId, decision, note?, actor?: 'reviewer' | 'system', reviewer?: { id: string; name: string } | null)
  ```

- [ ] **Step 1: Policy.** `evaluateApproval` returns `approvalsRequired` (2 for `issue_refund` with `amount > fourEyes.refundOver` when enabled, 2 for `cancel_order` when `fourEyes.cancellations`, else 1; never changes `mode`). Table tests including boundary (`amount === threshold` → 1), disabled (0), auto-approve interplay (an auto-approved refund never parks). The `requested` audit event's `detail` gains `approvalsRequired` when 2; `createAction` stores `approvals_required` from the policy result.
- [ ] **Step 2: Store `approveStep`.** One transaction: `SELECT … FROM actions WHERE id = $1 FOR UPDATE`; if status is not `pending_approval` → return `null`; if the reviewer already has an `action_approvals` row → throw `ConflictError('You have already approved this', 'ALREADY_APPROVED_BY_YOU')` (check how `ConflictError`/`DomainErrorFilter` expose codes; extend minimally); insert the row; count rows joined to **active** reviewers; if below `approvals_required` → insert a `first_approval` event (actor = reviewer id, `detail: { given, required }`), `publish` trace/approvals/audit, return `{ action, final: false }`; else perform the existing approve transition (status `approved`, `decided_at`, `approved` event with actor id) and return `{ action, final: true }`. For `approvals_required = 1` actions keep the existing `decideAction` path untouched (single UPDATE) so existing behaviour and tests do not move. Reject path: pass the reviewer id into the audit actor.
- [ ] **Step 3: Runner.** `decide(…, reviewer)`: for an approve on an action with `approvalsRequired === 2`: require a reviewer identity (else `ConflictError` code `FOUR_EYES_NEEDS_ACCOUNTS`), call `approveStep`; if `!final` return `{ action, run }` without `complete()` (run stays `awaiting_approval`); if final continue into `complete()` exactly as today. Rejects by key/demo callers still work. `recover()` is unaffected. The in-memory `MemoryStore` in `test/fakes.ts` implements the same semantics (approvals set per action, active reviewers set) so runner unit tests can cover: first approval pending, same reviewer refused, second reviewer executes once (refund recorded once), reject after first approval, deactivated first approver not counted, key caller refused with `FOUR_EYES_NEEDS_ACCOUNTS`, expiry of a half-approved action rejects it with the system actor, 1-approval flows unchanged.
- [ ] **Step 4: Controller and views.** `POST /approvals/:id` passes `req.principal` when it is a reviewer (id, name). `listApprovals`/`getAction`/trace return `approvalsRequired`, `approvalsGiven`, `approvedBy` for reviewers; `approvalForCaller` strips all three for non-reviewers (extend the existing helper and its tests). `listApprovalEvents` and the conversation trace events return `actorName` via `LEFT JOIN reviewers ON reviewers.id::text = approval_events.actor_id`.
- [ ] **Step 5: e2e** `four-eyes.e2e-spec.ts` (create two reviewers, log both in, cookies + CSRF header): refund over the threshold parks with `approvalsRequired: 2`; first approval leaves it `pending_approval`, writes a `first_approval` audit event with the reviewer's name, no refund yet; the same reviewer again → 409 `ALREADY_APPROVED_BY_YOU`; the second reviewer executes exactly one refund and the run completes; two concurrent second approvals (two more reviewers, `Promise.all`) → exactly one 201 and one 409, one refund row; the SAME reviewer sending two concurrent first approvals → one success, one 409, still pending; reject by one reviewer rejects and the agent tells the customer; cancellation flag on/off; threshold boundary; the deactivated first approver case via SQL/admin route; expiry of a half-approved action; a customer's `GET /conversations/:id` has none of `approvalsRequired/approvalsGiven/approvedBy`; key-mode/demo-mode approvals of 1-approval actions unchanged. Extend `audit-log.e2e-spec.ts`: approved/rejected events carry `actorId` and `actorName` for reviewer sessions and null for key mode.
- [ ] **Step 6: Run** unit specs, the new e2e, the whole API suite, root `npm run typecheck`. Commit (two fine): `Add the four-eyes policy and the approveStep transaction`, `Name the reviewer in audit events and approval views`.

---

### Task 5: Web console

**Files:**
- Modify: `apps/web/src/app/api/[...path]/route.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/session.ts`, `apps/web/src/lib/types.ts`, `apps/web/src/app/reviewer/page.tsx`, `apps/web/src/components/{TopBar,ApprovalsPanel,AuditLog}.tsx`
- Create: `apps/web/src/components/{LoginForm,ReviewersPanel,ChangePassword}.tsx`, tests under `apps/web/src/lib/*.test.ts`

**Interfaces:**
- Consumes: API routes and shapes from Tasks 3-4 (`/health.reviewerAccounts`, `/auth/*`, `/reviewers`, `approvalsRequired/approvalsGiven/approvedBy`, `actorName`).
- Produces: proxy that forwards `cookie` and returns every `Set-Cookie`; `api` helpers sending `X-Requested-By: reviewer-console` on non-GET; pure helpers (unit-tested): `needsLogin(health, me)`, `approvalProgress(a)` -> `"1 of 2 approvals"`, `canApprove(a, me)`.

- [ ] **Step 1: Proxy.** Add `cookie` to the forwarded request headers and return all `Set-Cookie` values with `Headers.append` for each of `upstream.headers.getSetCookie()`; SSE responses keep their no-cache headers. The proxy still holds no secrets. (Check the Next.js 16 route-handler docs via Context7 for `getSetCookie` / streaming behaviour and state the version.)
- [ ] **Step 2: Console.** `/health.reviewerAccounts` true → show `LoginForm` (email, password, error text for the uniform 401, disabled while submitting); after login call `/auth/me`, keep the reviewer in React state only (no token in storage; the cookie is httpOnly); TopBar shows the reviewer's name and a "Log out" button (and "Change password" opens `ChangePassword`); a 401 from any call returns to the login form. Key mode keeps the existing key box and `sessionStorage` behaviour untouched; demo mode unchanged.
- [ ] **Step 3: Approvals and audit.** Approval cards show `approvalProgress` and who approved first; Approve is disabled for a reviewer who already approved, with a short explanation, Reject stays; copy never claims a refund was issued before the final approval. `AuditLog` renders `actorName` (fallback to the existing "reviewer"/"system" wording) and the `first_approval` kind ("First approval").
- [ ] **Step 4: Admin tab.** For `role === 'admin'` a "Reviewers" tab (`ReviewersPanel`): list, add (email, name, role, password), change role, deactivate/reactivate, set a new password; the last-admin 409 shows the API message; no password is ever rendered or stored.
- [ ] **Step 5: Tests and checks.** `node:test` unit tests for the three pure helpers (including edge cases: not logged in, 1-approval action, admin vs reviewer). Run `npm run typecheck`, `npm test -w apps/web`, `npm run build` (a first-run Next error: retry once; do not run `next upgrade`). If you can run the app against a throwaway database you may check the login flow in a browser; otherwise say plainly that no manual browser check was done.
- [ ] **Step 6: Commit** `Add reviewer login, four-eyes progress and the reviewers tab to the console`.

---

### Task 6: Docs

**Files:** Modify `README.md`, `TODO.md`, `.env.example` (only if Task 1 missed something)

- [ ] **Step 1: README.** An "Accounts and four-eyes" section: the modes table; first-admin command (`REVIEWER_PASSWORD`, never a flag); login/session/cookie/CSRF notes; the new variables with defaults in the main configuration table and `.env.example`; four-eyes rules and the `409` codes; what customers never see; the new security notes (uniform login error, lockout trade-off of targeted lock-out, no email reset, no MFA/SSO, sessions are DB rows, admin actions are logged not audited); the testing bullets. Every claim must be verified against the code and tests; do not claim a manual browser check unless one was actually done.
- [ ] **Step 2: TODO.md.** Keep `4.5` unticked but append a sub-line: `- [x] 4.5a Reviewer accounts and four-eyes` and `- [ ] 4.5b Customer login (email magic link)` directly under it (or tick 4.5 only when 4.5b lands).
- [ ] **Step 3: Run** `npm run typecheck`, `npm test` (with `E2E_DATABASE_URL`) and fix any README claim the code does not support.
- [ ] **Step 4: Commit** `Document reviewer accounts and four-eyes; record 4.5a in TODO`.
