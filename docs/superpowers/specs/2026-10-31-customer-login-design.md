# Customer login by email magic link (TODO 4.5b)

TODO 4.5 reads "per-reviewer accounts, four-eyes rule, then customer login". The first two shipped as 4.5a
(`2026-10-29-reviewer-accounts-four-eyes-design.md`). This spec is the last part: customers prove who they are, so a
conversation is bound to a customer the server has verified, never to an id or email the caller typed.

## Goal

Today anyone can start a conversation as any customer by `customerId` or account email, and a conversation is protected
only by a token the browser keeps. The guardrails bind the *agent* to one customer; nothing proves the *caller* is that
customer. Add an opt-in login mode in which a customer signs in with a one-time link sent to their email address.

Success criteria:

- With login on, a conversation can be started, read, written to or streamed only by the customer it is bound to (or a
  reviewer). Another customer, an anonymous caller, an unknown id and a wrong id all get the same `401`.
- The customer is taken from the verified session. A `customerId` or `email` in a request body is refused.
- A signed-in customer can come back to earlier conversations (`GET /my/conversations`) without any stored token.
- The sign-in request answers identically whether or not the email belongs to a customer; the link is single use, short
  lived and never reaches a log, a URL path, a `Referer` header or an API response.
- A customer never gains reviewer powers or sees reviewer-only data (policy, notification and four-eyes fields).
- With login off (the default), demo, key and conversation-token behaviour is exactly as today.

## Decisions made

| Question | Decision |
|---|---|
| Enforcement | Opt-in mode switch: `CUSTOMER_LOGIN=true`. Off by default so the zero-config demo keeps working. |
| Access once on | The session replaces conversation tokens. Access follows `conversations.customer_id`. |
| Who can sign in | Only emails already in `customers` (case-insensitive). No sign-up, no new customers. |
| Delivery | Email over SMTP (own settings, see section 5). Login mode refuses to start without it. No dev shortcut that prints links. |
| Link | 32 random bytes, only the SHA-256 stored, 15 minutes, single use, in the URL fragment. |
| Session | Server-side row, `customer_session` cookie, 7 days absolute, 24 h idle. Same pattern as reviewer sessions. |

## 1. Modes

`CUSTOMER_LOGIN` is independent of the reviewer modes in the 4.5a spec (demo, key, accounts).

| `CUSTOMER_LOGIN` | Conversations are reached with | Start a conversation |
|---|---|---|
| unset / `false` | the conversation token, or a reviewer (as today) | body `customerId` or `email` (as today) |
| `true` | a customer session for that conversation's customer, or a reviewer | the session's customer only |

- `loadConfig` rejects `CUSTOMER_LOGIN` values other than `true` or `false`, and `CUSTOMER_LOGIN=true` without
  `LOGIN_SMTP_URL` and `LOGIN_EMAIL_FROM` (both validated like the notification SMTP settings).
- `GET /health` adds `customerLogin: boolean`.
- **Demo reviewer mode does not open conversations in login mode.** Today the `demo` principal (no reviewers, no key) is
  allowed everywhere. With `CUSTOMER_LOGIN=true` the conversation guard treats `demo` like `none`, otherwise the open
  demo would bypass the login. Reviewer routes (`/approvals`, ...) stay open in that mode, as the demo promises, and the
  API logs a startup warning that customer login is on while reviewer routes are open. Key and accounts modes are
  unaffected: `key` and signed-in reviewers keep full conversation access.
- Existing conversations are already bound to a customer (`customer_id NOT NULL`), so on upgrade a customer sees their
  earlier chats after signing in. Their stored tokens stop being accepted in login mode (and still work with it off).

## 2. Data

All DDL is idempotent (`IF NOT EXISTS`) and the new tables are added to `RESET_SQL`.

- `login_links(id uuid PK default gen_random_uuid(), customer_id int NOT NULL REFERENCES customers ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  used_at timestamptz)`; index on `(customer_id, created_at)`.
- `customer_sessions(id uuid PK, customer_id int NOT NULL REFERENCES customers ON DELETE CASCADE, token_hash text NOT NULL
  UNIQUE, created_at, last_seen_at, expires_at)`; index on `customer_id`.
- `conversations.access_token_hash` stays nullable. A conversation started in login mode has none (and no
  `accessToken` is returned), so it cannot be reached by token if login is later switched off, until a reviewer or the
  customer starts a new one.

## 3. The magic link

- **Request.** `POST /customer-auth/request { email }` always answers `202 { "status": "sent" }`. It sends mail only when
  the email matches a customer and the abuse limits below allow it; every other case is silent. The handler does the
  same lookup either way and **does not wait for the mail**: the send runs after the response, so a slow SMTP server
  cannot make a known email answer measurably slower than an unknown one. Mail errors are logged without the address or
  the link and never change the answer.
- **Abuse limits.** A per-client rate limit (`RATE_LIMIT_CUSTOMER_LOGIN_PER_MINUTE`, default 5) answers `429` like the
  other limits (it depends only on the client, so it reveals nothing about emails). Per email, at most 5 links may be
  created in any rolling hour, counted in `login_links`; beyond that nothing is sent but the answer is still `202`. When
  a new link is created, all but the 2 newest unused links of that customer are expired.
- **The link** is `<CUSTOMER_APP_URL>/login#token=<token>` (`CUSTOMER_APP_URL`, default `http://localhost:3000`, validated
  like the other console URLs). The fragment is never sent to a server, so it cannot appear in the web or API logs or in
  `Referer`. The landing page removes it from the address bar (`history.replaceState`) as soon as it has read it.
- **Verify.** The landing page posts `POST /customer-auth/verify { token }`, so a mail scanner or link preview that
  merely fetches the URL consumes nothing. The token is consumed in one statement
  (`UPDATE login_links SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING
  customer_id`), so two requests with the same token yield exactly one session. Success: a new `customer_session` row, the
  cookie, and `200 { customer: { id, name, email } }`. Every failure (unknown, expired, used, malformed) is the same
  `401 Invalid or expired link`.
- **CSRF.** Both endpoints need `X-Requested-By` (see section 4), so a cross-origin page cannot trigger a mail or fix
  an attacker's session onto a victim (login CSRF); `SameSite=Strict` is the second layer.

## 4. Sessions

- Cookie `customer_session`: 32 random bytes, base64url, only the SHA-256 stored; `HttpOnly; SameSite=Strict; Path=/`,
  `Secure` under the same `COOKIE_SECURE` rule as `reviewer_session`. Lifetime `CUSTOMER_SESSION_TTL_DAYS` (default 7)
  absolute, 24 h idle, `last_seen_at` refreshed at most once a minute. A new token at every login. Expired rows are
  deleted opportunistically at login.
- `POST /customer-auth/logout` ends this session; `POST /customer-auth/logout-all` ends every session of the customer.
  `GET /customer-auth/me` returns `{ customer }` or `401`.
- CSRF: a request authenticated by the customer cookie that is not `GET`/`HEAD`, and both unauthenticated
  `/customer-auth` POSTs, must carry `X-Requested-By` (the console and the chat page already send it on every non-GET
  call; its value is only a marker), else `403`.
- The session reuses the reviewer-session code (token hashing, cookie options, cookie reading, idle refresh) through one
  small shared helper instead of a copy; the two tables and the two cookie names stay separate.

## 5. Email

- A separate sender, **not** the reviewer notification channel: that channel is built to carry no customer data and to
  reach reviewers, while this mail is addressed to a customer by definition.
- Settings: `LOGIN_SMTP_URL`, `LOGIN_EMAIL_FROM`, validated by the same rules as `NOTIFY_SMTP_URL` (smtp/smtps, host
  required, STARTTLS for remote hosts, no query string or fragment, 5 s connection/greeting timeouts; the URL is never
  logged and the library's `logger`/`debug` stay off). The transport is created once and closed on shutdown.
- Plain-text only. The body is a short sentence, the link and its expiry. It contains no name, order, conversation or
  other customer data.

## 6. Identity in the request pipeline

- `Principal` gains `{ kind: 'customer'; customerId: number; email: string; name: string }`, resolved only in login mode,
  from the customer cookie. `PrincipalMiddleware` still runs first for every route.
- Resolution order in login mode: reviewer principal first (reviewer cookie, or the key / demo rules of 4.5a), then the
  customer cookie. Both cookies may exist in one browser; a reviewer cookie wins, so a reviewer testing the customer page
  is a reviewer there (the customer page sends the CSRF header too).
- **A customer is not a reviewer.** `isReviewerPrincipal` currently means "anything but `none`". It must be `demo`, `key`
  or `reviewer` only. Every use is audited in this change: `ReviewerGuard`, `AdminGuard`, `approvalForCaller`,
  `forCaller`, the conversation `trace`/`send` views, `csrfOk` and `/auth/me`. A customer principal on a reviewer route is
  `401`; on a customer route it sees the customer view (generic run errors; no policy, notification or four-eyes fields).
- `ConversationAccessGuard`:
  - reviewer principal: allowed (CSRF rule as in 4.5a);
  - customer principal in login mode: allowed only when `conversations.customer_id` equals the session's customer;
    anything else, including a conversation of another customer or a non-existent id, is the same `401` as before;
  - login mode, any other principal (`none`, `demo`): `401`; conversation tokens are not consulted;
  - login off: unchanged (token or reviewer).
- `POST /conversations`: in login mode requires a customer session (reviewers and everyone else `401`), refuses a body with
  `customerId` or `email` (`400`), binds the conversation to the session's customer and returns it without an
  `accessToken`. `title` stays optional. With login off: unchanged.
- `GET /my/conversations`: a customer's own conversations, newest first, with the same summary shape the reviewer list
  uses minus reviewer-only fields (no token usage, no pending-approval counts beyond a boolean `awaitingApproval`).
  Without a customer principal: `401`.
- Streams: `/conversations/:id/events` goes through the same guard. Customers still receive only `trace` signals for their
  own conversation and never `approvals` or `audit`; `/events` stays reviewer-only.
- `GET /customers` (the demo picker's directory) stays reviewer-only, so it is `401` for a customer.

## 7. Web

- `/health.customerLogin` true: the customer page shows an email field and "Send me a sign-in link" instead of the demo
  picker, then a "Check your inbox" state (the same text for every email). `/login` reads the fragment, posts it, shows the
  generic error on failure, and on success goes to the chat page.
- The chat page then loads `/my/conversations`, shows the signed-in customer's name with "Log out" and "Sign out
  everywhere", and uses no conversation token and no `localStorage` chat list in this mode. Starting a conversation sends
  no customer id or email. A `401` anywhere returns to the sign-in form with "Your session ended".
- Login off: the page is unchanged. The reviewer console is unchanged.
- The Next.js proxy already forwards the cookie, `X-Requested-By` and every `Set-Cookie`; no change is needed there.

## 8. Testing

- Unit: config rules (`CUSTOMER_LOGIN` values, the SMTP/from/URL requirement, defaults); link and session token lifecycle with
  an in-memory store (single use, expiry, replay, idle, logout-all); the "always 202" request path for known, unknown and
  rate-limited emails; the email message (against nodemailer's JSON transport: contains the link and expiry, no name or
  other customer data); principal resolution per mode and cookie combination; `isReviewerPrincipal` audited for every
  principal kind (a customer is not a reviewer on any guard or view helper); the CSRF rule for the customer cookie.
- E2E on Postgres (port 5435 `aiagent_test` only):
  - Concurrent verifies of one token create exactly one session.
  - Customer A cannot read, post to, list or stream customer B's conversation, and the answer is identical to an unknown
    id. An anonymous caller and `demo` get `401`. A body `customerId` or `email` is `400`. A customer gets `401` on
    `/approvals`, `/customers`, `/events` and the reviewer routes.
  - A customer's `GET /conversations/:id` has none of the policy, notification or four-eyes fields and a generic run
    error; a reviewer's still has them.
  - The request answer and timing class are identical for a known and an unknown email, per-email and per-client limits
    hold, and expired/used/garbage tokens are one `401`.
  - Session expiry (SQL time travel), idle timeout, logout, logout-all; the CSRF header on every mutating cookie route and
    on both `/customer-auth` POSTs.
  - Existing conversations of a customer appear after sign-in, and old conversation tokens are refused in login mode.
  - Both cookies at once: the reviewer wins on reviewer routes.
  - Login off: every existing suite passes unchanged.
- A local SMTP stand-in is not needed: the mail goes through nodemailer's JSON transport in tests.
- Web: `node:test` for the fragment reader and the sign-in state helpers. A manual browser check is done against a
  throwaway database and reported honestly (the SMTP leg cannot be exercised without a real server).

## 9. Docs and limitations

- README: a "Customer login" section (the mode table, variables with defaults, the flow, what is protected), the Security
  notes "no customer login" bullet and the Known limitations updated, `.env.example` entries, TODO 4.5b and then 4.5 ticked.
- Documented limitations: the link is only as safe as the customer's mailbox; a stolen valid session cookie is a
  customer's session until it expires or they sign out; the per-email limit lets a nuisance caller use up a customer's
  hourly link allowance (known trade-off); sessions are server-side rows; no sign-up, passwords, MFA or SSO; mail delivery
  failures are logged, not retried; the real SMTP leg was not exercised against a live mail server.

## Out of scope

Creating customers or changing their email, passwords or MFA, SSO/OIDC, account recovery beyond a new link, remembering a
device, per-customer rate limits beyond the above, retrying failed mail, HTML email, a dev mode that prints links.
