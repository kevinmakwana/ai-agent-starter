# Reviewer accounts and the four-eyes rule (TODO 4.5, part 1)

TODO 4.5 reads "per-reviewer accounts, four-eyes rule, then customer login". This spec covers the first two. Customer login
is a separate spec (email magic link) that reuses the session code built here.

## Goal

Today every reviewer shares one `REVIEWER_API_KEY`, so the audit log can only say "a reviewer". Give each reviewer their own
login so every decision names a person, and let operators require two different people to approve the riskiest actions.

Success criteria:

- Each reviewer signs in with their own email and password; sessions end on logout, expiry, idle timeout, deactivation and
  password change.
- Every approval, rejection and first approval in the audit log names the reviewer who did it.
- With four-eyes on, a parked refund over the threshold (and, if enabled, any cancellation) is executed only after two
  different active reviewers have approved it; a single reject still rejects it; one reviewer can never supply both approvals,
  even by racing two requests.
- Zero-config demo mode and the shared-key mode keep working exactly as before until the first reviewer account exists.
- No password, session token or hash appears in a response, a log or an error, and cookies cannot be abused cross-site.

## Decisions made

| Question | Decision |
|---|---|
| Reviewer sign-in | Email + password, server-side session in an httpOnly cookie. No SSO, no MFA, no email reset (out of scope). |
| Shared `REVIEWER_API_KEY` once accounts exist | Ignored for reviewer routes (startup warning), so every action has a named person. |
| Four-eyes trigger | `FOUR_EYES_REFUND_OVER` (dollars, refund amount strictly over it; unset or 0 = off) and `FOUR_EYES_CANCELLATIONS` (default off). Fixed at parking time. |
| Rejecting | One reject from any reviewer rejects immediately. |
| Admin actions | An `admin` role manages reviewers. The audit table is per-approval, so reviewer-management actions are written to the application log only. |

## 1. Modes

| Reviewers in DB | `REVIEWER_API_KEY` | Mode | Reviewer routes accept |
|---|---|---|---|
| none | unset | demo (open) | everyone (as today) |
| none | set | key | `Authorization: Bearer <key>` (as today) |
| 1 or more | any | accounts | a valid session cookie only |

- Mode is decided per request from the database (a cheap `EXISTS` check cached for a few seconds and invalidated when a
  reviewer is created), so creating the first reviewer switches the running API to accounts mode.
- `GET /health` keeps `reviewerAuth: boolean` (true in key and accounts mode) and adds `reviewerAccounts: boolean`.
- In accounts mode the API logs a warning at startup if `REVIEWER_API_KEY` is also set ("ignored").
- Four-eyes needs identity. If the four-eyes settings are on while the API is in demo or key mode, nothing fails at startup
  (the first reviewer can be created later); an approval parked with `approvals_required = 2` simply cannot be approved by a
  key or demo caller (409 `FOUR_EYES_NEEDS_ACCOUNTS`, see section 5), and a startup warning says so.

## 2. Data

- `reviewers(id uuid PK default gen_random_uuid(), email text NOT NULL UNIQUE (stored lower-cased), name text NOT NULL,
  password_hash text NOT NULL, role text NOT NULL CHECK IN ('admin','reviewer'), active boolean NOT NULL DEFAULT true,
  failed_attempts int NOT NULL DEFAULT 0, locked_until timestamptz, created_at, last_login_at)`.
- `reviewer_sessions(id uuid PK, reviewer_id uuid NOT NULL REFERENCES reviewers ON DELETE CASCADE, token_hash text NOT NULL
  UNIQUE, created_at, last_seen_at, expires_at)`; index on `reviewer_id`.
- `actions.approvals_required int NOT NULL DEFAULT 1`.
- `action_approvals(action_id uuid REFERENCES actions ON DELETE CASCADE, reviewer_id uuid REFERENCES reviewers, note text,
  created_at, PRIMARY KEY (action_id, reviewer_id))`.
- `approval_events.kind` CHECK widened with `first_approval` (drop and re-add the constraint, idempotently, as was done for
  `runs`). `actor_id` (existing text column) now holds the reviewer id for reviewer decisions.
- All DDL is idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) and `RESET_SQL` truncates the new tables.
  The seed creates no reviewers (demo mode stays the default); e2e tests create their own.

## 3. Passwords, sessions, login

- Passwords: Node `crypto.scrypt` (N=2^15, r=8, p=1, 64-byte key, 16-byte random salt), stored as
  `scrypt$N$r$p$<salt b64>$<hash b64>`; verification parses the parameters, uses `timingSafeEqual`, and rehash-on-login is
  out of scope. Minimum 12 characters, maximum 200 (bounds scrypt cost). Unknown email runs a dummy verification so timing
  does not reveal which emails exist.
- Login: `POST /auth/login { email, password }` → 200 `{ reviewer }` and a session cookie, or a uniform 401
  `Invalid email or password` for unknown email, wrong password, inactive account and locked account alike.
  Throttling: the route has its own limit `RATE_LIMIT_LOGIN_PER_MINUTE` (default 10 per client), and an account is locked for
  15 minutes after 5 consecutive failures (counter reset on success). A locked or inactive account still answers 401.
- Sessions: a 32-byte random token (base64url) is the cookie value; only its SHA-256 is stored. Lifetime
  `SESSION_TTL_HOURS` (default 12, absolute) and 30 minutes idle (`last_seen_at` refreshed at most once a minute).
  A new token is issued at every login (no fixation). Expired rows are deleted opportunistically.
- Cookie: `reviewer_session`, `HttpOnly; SameSite=Strict; Path=/`, `Secure` when `COOKIE_SECURE=true` (default true when
  `NODE_ENV=production`), `Max-Age` equal to the absolute lifetime. The API parses the `Cookie` header itself (no new
  dependency).
- CSRF: a request authenticated by the cookie that is not `GET`/`HEAD` must carry `X-Requested-By: reviewer-console`, else
  403. A cross-origin page cannot add a custom header without a CORS preflight, which the exact-origin `CORS_ORIGINS`
  list refuses; `SameSite=Strict` is the second layer. Bearer-key and demo requests are not affected.
- `POST /auth/logout` deletes the session and clears the cookie. `GET /auth/me` returns `{ reviewer }` or 401.
  `POST /auth/password { current, next }` verifies the current password, sets the new one and deletes every other session of
  that reviewer.
- Admin routes (role `admin`): `GET /reviewers`, `POST /reviewers { email, name, role, password }`,
  `PATCH /reviewers/:id { name?, role?, active?, password? }`. Deactivating, demoting or resetting a password deletes that
  reviewer's sessions immediately. The last active admin cannot be deactivated or demoted (409). Responses never include
  `password_hash`, `failed_attempts` or tokens. Each admin action is logged (`Logger('Reviewers')`) with actor and target ids,
  never passwords.
- First admin: `npm run reviewer:add -w apps/api -- --email you@example.com --name "You"` creates an admin; the password is
  read from the `REVIEWER_PASSWORD` environment variable or prompted for on a TTY (never accepted as a flag, so it stays out
  of shell history). It fails if the email exists.

## 4. Identity in the request pipeline

- A global middleware resolves a **principal** for every request and stores it on `req.principal`:
  `{ kind: 'demo' } | { kind: 'key' } | { kind: 'reviewer', id, email, name, role } | { kind: 'none' }`.
  `isReviewer(req)` becomes `principal.kind !== 'none'`. `ReviewerGuard`, `ConversationAccessGuard`,
  `ConversationsController.isReviewer`, the event-stream controller and the admin guard all read the principal, so SSE
  streams authenticate with the cookie too. Customers still use `X-Conversation-Token` and are `none`.
- The existing `isReviewer(reviewerApiKey, authorization)` helper stays as the key-mode check used by the middleware.
- `runner.decide` takes the principal's `{ id, name }` (reviewer kind only); audit events use `actorId = reviewer id`.
  Key and demo callers keep `actorId = null`.
- `GET /approvals`, `GET /approvals/events` and the conversation trace return `actorName` per event (left join on
  `reviewers`, so a name is shown even for a deactivated reviewer); rows with a null actor show nothing.

## 5. Four-eyes

- `ApprovalPolicyConfig` gains `fourEyes: { refundOver: number; cancellations: boolean }` (`FOUR_EYES_REFUND_OVER` via the
  existing dollar parser, `0`/unset = off; `FOUR_EYES_CANCELLATIONS` accepts `true`/`false`, default false, anything else is
  a startup error). `evaluateApproval` still returns `mode: 'human'` plus a rule and now also `approvalsRequired: 1 | 2`:
  2 for `issue_refund` with `amount > refundOver` when that is enabled, and for `cancel_order` when `cancellations` is on.
  It never affects auto-approval (an auto-approved refund never parks).
- The count is stored on the action when it is created and echoed in the `requested` audit event's `detail`
  (`approvalsRequired`). Changing the settings later never changes parked approvals.
- Approving an action with `approvals_required = 2`, in one transaction under `SELECT … FOR UPDATE` on the action row:
  1. refuse if the action is no longer `pending_approval` (409, as today);
  2. refuse with 409 `ALREADY_APPROVED_BY_YOU` if this reviewer already has a row in `action_approvals`;
  3. insert the row; count approvals from **active** reviewers only;
  4. below the requirement: write a `first_approval` audit event (actor = this reviewer), publish `approvals`/`audit`/
     `trace`, and return the action still `pending_approval` with the run still `awaiting_approval` (no execution);
  5. at the requirement: the existing approve transition (status `approved`, `approved` audit event with this reviewer as
     actor, execution, run resumes). Only the transaction that reaches the count executes, so two reviewers approving at the
     same moment execute exactly once.
- A reviewer who is deactivated after giving the first approval no longer counts, so the next approver is again the "first".
- Reject by any one reviewer rejects (unchanged path, with the reviewer as actor). Expiry still rejects a partly approved
  action with the system actor.
- Key and demo callers cannot give approvals on `approvals_required = 2` actions (409 `FOUR_EYES_NEEDS_ACCOUNTS`); they can
  still reject.
- API shape: reviewer views of an approval gain `approvalsRequired`, `approvalsGiven` and `approvedBy` (names); customers never
  receive them (`approvalForCaller`). Notifications (4.4) are unchanged and fire once, when the action is parked.

## 6. Web

- The reviewer console asks `/health`: `reviewerAccounts` → an email/password login form (and a name + "Log out" in the top
  bar); otherwise the existing key box. On 401 in accounts mode the console returns to the login form.
- Fetches add `X-Requested-By: reviewer-console` on non-GET requests. The Next.js proxy forwards the `cookie` request header
  and returns every `Set-Cookie` header from the API (it still holds no secrets).
- Approval cards show `1 of 2 approvals` and who gave the first one; the Approve button is disabled for that same reviewer
  with a short explanation; Reject stays available. The audit log shows names.
- Admins get a "Reviewers" tab: list, add, change role, deactivate/reactivate, set a new password. A "Change password"
  control is available to everyone signed in.

## 7. Testing

- Unit: password hash/verify (format, wrong password, tampered parameters, dummy verification path), session store logic
  (expiry, idle, deletion), principal resolution in each mode, CSRF header rule, policy `approvalsRequired` table, the
  runner four-eyes flow with the in-memory fakes (first approval keeps it pending, same reviewer refused, second reviewer
  executes once, reject, deactivated approver not counted, key caller refused), config parsing (booleans, dollar threshold).
- E2E (port 5435 `aiagent_test` only): login/logout/me and cookie attributes; uniform 401 for unknown/wrong/inactive/locked;
  lockout after 5 failures; login rate limit; expired and idle sessions; deactivation and password change end sessions; CSRF
  header required for cookie mutations and not for key mode; the shared key is ignored once a reviewer exists; SSE
  (`/events`) works with the cookie; admin routes forbidden for non-admins, last admin protected, no hash in any response;
  four-eyes over HTTP: refund over the threshold needs two different reviewers (first leaves it pending and audited as
  `first_approval`, second executes once), same reviewer 409, two concurrent second approvals execute exactly once, reject by
  one reviewer, cancellation flag, expiry of a half-approved action, audit `actorName`; existing suites pass unchanged
  (demo and key mode).
- Web: `node:test` for the principal-aware helpers and the approval-card copy.

## 8. Docs and limitations

- README: an "Accounts and four-eyes" section (modes table, variables, first-admin command, cookie and CSRF notes, four-eyes
  rules) and updates to the security notes; `.env.example`; TODO 4.5 stays unticked until customer login lands, with a
  sub-line noting reviewer accounts and four-eyes are done.
- Documented limitations: no email-based reset (an admin sets a new password), no MFA/SSO, sessions are server-side rows (no
  stateless tokens), login throttling is per client address and per account, account lockout allows a targeted lock-out
  of a known email (a known trade-off), scrypt parameters are fixed in the stored string and not auto-upgraded, the audit
  table does not record reviewer-management actions.

## Out of scope

Customer login (next spec), password reset by email, MFA, SSO/OIDC, per-reviewer notification routing, session listing
UI, rehash-on-login, a separate audit table for admin actions.
