# ai-agent-starter

[![CI](https://github.com/kevinmakwana/ai-agent-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/kevinmakwana/ai-agent-starter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A small, framework-free **tool-calling agent** for a fictional store, "Acme Shop", built with NestJS, Next.js and Postgres. It answers support questions by calling schema-validated tools against a real database, enforces guardrails in code (not in the prompt), parks risky actions like refunds and order cancellations until a human approves them, and persists every run as an inspectable trace. It runs end to end with **zero API keys** thanks to a deterministic offline mock provider; OpenAI and Anthropic are one env var away.

![Reviewer console: conversation, live agent trace and a refund waiting for approval](docs/screenshot.png)

<details>
<summary>More views: the approvals tab and the customer chat</summary>

![Approvals tab with the agent's reasoning and order context](docs/approvals.png)

![Customer chat, paused while a reviewer decides](docs/customer.png)

</details>

## Why this exists

- **The agent loop is ~150 lines you can read** ([runner.ts](apps/api/src/agent/runner.ts)): no LangChain, no hidden prompts, no magic. Good starting point for understanding what agent frameworks actually do.
- **Guardrails live in code.** The conversation is bound to one customer, tool arguments are JSON-schema validated before execution, unknown tools are rejected, refunds can't exceed the order total minus earlier refunds and only a `processing` order with no refunds can be cancelled (both re-checked in a row-locking transaction at approval time), and runs have a step limit.
- **Human-in-the-loop done properly.** Risky tool calls become `pending_approval` actions, the run pauses (and survives restarts, since history is rebuilt from Postgres), and `POST /approvals/:id` resumes it. Refunds under `REFUND_AUTO_APPROVE_UNDER` skip the queue (cancellations never do), and every decision, automatic or human, lands in the audit log.
- **Everything is a trace.** Every run stores each step: role, content, tool, args, result, latency and tokens.
- **Offline by default.** A rule-based mock planner makes the demo, tests and CI deterministic and free; real providers are plain `fetch` adapters behind a one-method interface.

## Architecture

```mermaid
flowchart LR
  subgraph Web["Next.js (apps/web)"]
    UI["Conversations · Chat · Trace · Approvals"]
  end
  subgraph API["NestJS (apps/api)"]
    HTTP["HTTP controllers<br/>(class-validator)"]
    Runner["AgentRunner<br/>loop · max 8 steps"]
    Guard["Guardrails + JSON-schema<br/>tool validation"]
    Tools["Tools: get_customer · list_orders · get_order<br/>create_ticket · track_shipment<br/>issue_refund (risky) · cancel_order (risky)"]
    HTTP --> Runner
    Runner --> Guard --> Tools
  end
  Provider{{"ChatProvider"}}
  Mock["Mock (offline)"]
  OpenAI["OpenAI"]
  Anthropic["Anthropic"]
  DB[("Postgres<br/>shop data · runs · steps · actions")]

  UI -- "/api/* proxy" --> HTTP
  Runner --> Provider
  Provider --- Mock
  Provider --- OpenAI
  Provider --- Anthropic
  Tools --> DB
  Runner -- "persist every step" --> DB
  Runner -. "risky call → pending_approval, run pauses" .-> UI
  UI -. "POST /approvals/:id → resume" .-> HTTP
```

### Live updates

The chat and the reviewer console update over SSE instead of polling. The store's run, step, approval and audit writes run `pg_notify` inside the same transaction, so Postgres delivers the signal only on commit. Creating a conversation and the shop-side writes (refunds, tickets) do not publish on their own; the step or result write that follows them does. One dedicated `LISTEN` connection per API process (`StreamBus`) fans the signals out to open streams, so it works across several API replicas on the same database. The connection uses TCP keepalive and a connect timeout, and is probed with `SELECT 1` every 30 s, so a silently dead connection is replaced (followed by a `resync`) rather than leaving clients on a frozen UI. The server sends a `: connected` comment on open and a `: ping` comment every 15 s, and a synthetic `resync` event if the `LISTEN` connection is lost and restored. The UI polls (chat 3 s, 500 ms while sending; console 2 s) only while the stream is not live, and a "Live / Connecting / Polling" chip in the top bar shows which mode it is in. Open streams are completed on shutdown so `SIGTERM` / `docker stop` does not hang; graceful shutdown can still wait a few seconds (the idle keep-alive timeout) for a pooled idle client socket.

## Quick start

Requires Node 22+ and Docker.

```bash
cp .env.example .env        # optional: defaults work; set DB_PORT if 5432 is busy
npm install
npm run db:up && npm run seed && npm run dev
```

**Upgrading an existing demo database?** Builds with `track_shipment` read a `shipments` table that older seeds did not fill. Re-run `npm run seed` once, otherwise shipped and delivered orders report "not shipped" (the seed resets the demo data).

Open <http://localhost:3000> (customer chat), start a chat as *Ava Brooks* and try:

1. `Show my recent orders`: a plain tool call.
2. `Order #1 arrived damaged, please refund it`: `get_order` → `issue_refund` pauses for approval; then open the reviewer console at <http://localhost:3000/reviewer> and approve it in the **Approvals** tab; the run resumes.
3. `Show me order #2`: blocked, that order belongs to another customer.
4. `refund order #1 for $500`: blocked by the over-refund guardrail before it ever reaches a human.
5. `Where is my order #1?`: a read-only `track_shipment` call (carrier, tracking number, status, latest scan). Order #1 is delivered; `Where is my order #11?` says it has not shipped yet.
6. `Cancel order #11, I ordered it by mistake`: `get_order` → `cancel_order` pauses for approval, always, whatever `REFUND_AUTO_APPROVE_UNDER` is. Approve it in the **Approvals** tab and the order becomes `cancelled`; reject it and the order is left alone. Cancelling a shipped or delivered order (try `Cancel order #1`) is refused before it reaches a human.

Seed data: 10 customers, 30 orders (order *N* belongs to customer `((N-1) % 10) + 1`), one prior partial refund on order 12, and a shipment (carrier, tracking number, status, ETA and scan events) for every shipped or delivered order. Ava owns orders 1, 11 and 21; order 11 is `processing`, so it is the one to cancel. Shipped orders such as #2 belong to other customers (#2 is Ben Carter's: start a chat as him to see one in transit).

### Using a real model

```bash
# .env
LLM_PROVIDER=anthropic          # or openai
ANTHROPIC_API_KEY=sk-ant-...
```

The adapters use the models in `ANTHROPIC_MODEL` / `OPENAI_MODEL`. They retry transient failures, refuse to act on a response that was cut off at the token limit (a truncated tool call is never executed) or declined by the provider, and the Anthropic adapter asks for prompt caching (cache reads are counted in the token totals and shown in the trace). Each run records the provider, model and a prompt version (a hash of the system prompt and tool definitions), shown in the reviewer trace.

They are tested against mocked `fetch` and against a local HTTP server that speaks each wire format, but **not against the live vendor APIs** from this repo's CI (that needs a key). Verify yours with a cheap two-call check:

```bash
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... npm run smoke:llm -w apps/api   # or openai
```

It asks "What did I order in order #1, and has any of it been refunded?", validates the tool call against the real tool schema, feeds a tool result back, and expects a plain-text answer. The second call matters most: it replays the model's own tool call, which is where history-format problems show up. The same check runs weekly (and on demand) in the **LLM smoke** GitHub Actions workflow if you add `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` as repository secrets; a provider without a secret is skipped.

## API

| Method & path | Purpose |
| --- | --- |
| `POST /conversations` | Create a conversation bound to `{ customerId }` or `{ email }`; returns the conversation plus its one-time `accessToken`. With `CUSTOMER_LOGIN=true`: only a signed-in customer, with an empty body, and no `accessToken` is issued |
| `GET /conversations` | 🔒 reviewer: list all conversations (with pending-approval counts) |
| `GET /conversations/:id` | 🔑 Full trace: runs → steps, plus approvals and token `usage` (per run and per conversation, with the budget) |
| `POST /conversations/:id/messages` | 🔑 Send `{ content }`; runs the agent until it answers or pauses (`409` while another run is in progress or an approval is pending) |
| `GET /conversations/:id/events` | 🔑 SSE stream of `trace` signals for one conversation (`429` over `STREAM_MAX_PER_CONVERSATION`) |
| `GET /approvals?status=pending` | 🔒  List approvals (`pending` \| `approved` \| `rejected` \| `all`) with customer, order (total, refunded so far, current `orderStatus`) and reasoning context |
| `GET /approvals/events` | 🔒 Append-only audit log of approval decisions, newest first (`conversationId`, `limit` up to 200, `before` event id). Kinds: `requested`, `auto_approved`, `first_approval`, `approved`, `rejected`, `expired`. Each carries `actorId` and `actorName` when a signed-in reviewer did it |
| `POST /approvals/:id` | 🔒 `{ decision: "approve" \| "reject", note? }`; executes the parked call and resumes the run (`409` if already decided). An action that needs two approvals (see [Accounts and four-eyes](#accounts-and-four-eyes)) only runs on the second |
| `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/password` | Reviewer sessions: sign in with `{ email, password }` (sets the cookie), sign out, who am I, change my password |
| `GET /reviewers` · `POST /reviewers` · `PATCH /reviewers/:id` | 🛡 admin: list, add, and edit reviewers (name, role, active, a new password) |
| `GET /events` | 🔒 SSE stream of `trace` / `approvals` / `audit` signals for the reviewer console (`429` over `STREAM_MAX_REVIEWER`) |
| `GET /customers` | 🔒 Customers for the demo picker (extra) |
| `POST /customer-auth/request` · `POST /customer-auth/verify` · `POST /customer-auth/logout` · `POST /customer-auth/logout-all` · `GET /customer-auth/me` | Customer login (`CUSTOMER_LOGIN=true`, otherwise `404`): ask for a link by `{ email }` (always `202`), redeem it with `{ token }` (sets the cookie), sign out, sign out everywhere, who am I. See [Customer login](#customer-login) |
| `GET /my/conversations` | 🍪 A signed-in customer's own conversations (login mode) |
| `GET /health` | API + database + active provider, `reviewerAuth` (a key or accounts are required) and `reviewerAccounts` (at least one reviewer exists) and `customerLogin` |

🔒 = a reviewer: the session cookie once reviewer accounts exist, otherwise the shared key (`Authorization: Bearer <REVIEWER_API_KEY>`). 🔑 = the conversation's `X-Conversation-Token`, or a reviewer. 🛡 = a reviewer with the `admin` role (a signed-in person: the shared key and demo mode have no identity and get `403`). 🍪 = a signed-in customer (the `customer_session` cookie). In login mode 🔑 means that customer's session (or a reviewer) instead of the token. Both 🔒 and 🔑 are open when no reviewer exists and `REVIEWER_API_KEY` is unset (demo mode).

Events are signals only (`{ "conversationId": "…" }`, no content; `resync` carries `{}`): clients refetch the normal endpoints to see what changed. The client sends its credential in headers (a `fetch`-based reader, not `EventSource`, which cannot set headers), and every connect is followed by a refetch.

Validation uses `class-validator` with `whitelist` + `forbidNonWhitelisted` (unknown fields → `400`). Upstream LLM failures return `502` with a clear message and mark the run `failed`. A failed run's stored error is shown verbatim only to reviewers; customers get a generic message.

## Accounts and four-eyes

Reviewers can have their own accounts, so the audit log names the person who decided, and two different people can be required for the riskiest actions.

**Modes** (decided per request, from the database):

| Reviewers in the database | `REVIEWER_API_KEY` | Mode | Reviewer routes accept |
| --- | --- | --- | --- |
| none | unset | demo (open) | everyone, as before |
| none | set | key | `Authorization: Bearer <key>`, as before |
| one or more | any | accounts | a valid session cookie only; the key is ignored (a warning is logged) |

Creating the first reviewer switches a running API to accounts mode (the "any reviewers?" answer is cached for up to 5 s in each process, so another replica can take that long to notice).

**First admin.** There is no HTTP route for this. Run it where the database is reachable; the password comes from the environment or a hidden prompt, never from a flag (so it stays out of shell history):

```bash
REVIEWER_PASSWORD='a long passphrase' npm run reviewer:add -w apps/api -- --email you@example.com --name "You"
# or run it without REVIEWER_PASSWORD in a terminal to be prompted twice
```

It fails if the email exists or the password is shorter than 12 characters. Note that `npm run seed` resets every table, reviewer accounts and sessions included, so run it before creating the first admin, not after. Further reviewers are added by an admin in the console's **Reviewers** tab (or `POST /reviewers`).

**Sign-in and sessions.** Email + password (scrypt, N=2^15; 12 to 200 characters). A session is a random 32-byte token in the `reviewer_session` cookie (`HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` when `COOKIE_SECURE=true`, which defaults to true when `NODE_ENV=production`). Only its SHA-256 is stored. A session ends on logout, after `SESSION_TTL_HOURS` (12) in total, after 30 idle minutes, when its reviewer is deactivated or demoted, and when a password is changed or reset (changing your own keeps the session you are using and ends the others). Every login issues a new token. Every failure is the same `401 Invalid email or password` (unknown email, wrong password, deactivated, locked), and an unknown email still pays for a hash. Five wrong passwords in a row lock the account for 15 minutes; `POST /auth/login` also has its own per-client limit (`RATE_LIMIT_LOGIN_PER_MINUTE`).

**CSRF.** A request authenticated by the cookie that is not `GET`/`HEAD` must carry `X-Requested-By: reviewer-console`, otherwise `403`. The console's fetch helper adds it to every non-GET call. A cross-origin page cannot add a custom header without a CORS preflight, which the exact-origin `CORS_ORIGINS` list refuses, and `SameSite=Strict` is a second layer. Key and demo requests carry no cookie and are not affected. The cookie rides along on the customer chat too, so a reviewer signed in to the same browser is treated as a reviewer there.

**Roles.** `reviewer` decides approvals. `admin` also manages reviewers. The last active admin cannot be deactivated or demoted (`409 LAST_ADMIN`, serialized with an advisory lock so two admins cannot demote each other at once).

**Four-eyes.** Set `FOUR_EYES_REFUND_OVER` (dollars; this refund's amount strictly over it) and/or `FOUR_EYES_CANCELLATIONS=true`. An action that qualifies is parked with `approvals_required = 2`, **fixed at that moment** (changing the settings later does not change parked approvals). Then:

- The first approval records who gave it and a `first_approval` audit event; nothing runs and the customer's run keeps waiting. The second approval, from a **different active reviewer**, runs the action once.
- Approving happens under a row lock on the action, so two reviewers approving at the same instant execute exactly once, and one reviewer racing two requests cannot supply both approvals (`409 ALREADY_APPROVED_BY_YOU`).
- **One rejection rejects.** Expiry still rejects a half-approved action, as the system.
- A reviewer who is deactivated after approving no longer counts; the next approver is again the first. Their name stays in the audit history.
- The shared key and demo mode cannot give an approval on a two-approval action (`409 FOUR_EYES_NEEDS_ACCOUNTS`); they can still reject. If four-eyes is on while no reviewer exists, the API says so at startup.
- If the action fails to run (infrastructure error) it goes back to pending with its approvals kept, and either approver can press Approve again to retry it.
- Business rules (refund balance, cancellation eligibility) are still re-checked when the action runs, and refunds and cancellations stay idempotent per action.
- Customers never see any of it: their view omits `approvalsRequired`, `approvalsGiven`, `approvedBy`, `approvedByIds` and the policy fields.

## Customer login

Optional (`CUSTOMER_LOGIN=true`). Without it nothing changes: anyone can start a conversation as a customer, and a conversation is protected by its token (see Security notes). With it, a customer proves who they are by email, and a conversation belongs to that verified customer.

| `CUSTOMER_LOGIN` | A conversation is reached with | A conversation is started by |
| --- | --- | --- |
| unset / `false` | its token, or a reviewer | a body `customerId` or `email` |
| `true` | the session of the customer it belongs to, or a reviewer | the signed-in customer (a body `customerId` or `email` is `400`) |

**Flow.** The customer enters their email; `POST /customer-auth/request` always answers `202` (it says nothing about whether the email is a customer). If it is one, a one-time link is mailed to it (the mail is sent after the response). The link is `<CUSTOMER_APP_URL>/login#token=...`: the token is in the fragment, so it never reaches a server log or a `Referer`, and the landing page removes it from the address bar. The page redeems it with `POST /customer-auth/verify`, which sets the `customer_session` cookie (`HttpOnly`, `SameSite=Strict`, `Secure` under `COOKIE_SECURE`, `CUSTOMER_SESSION_TTL_DAYS` absolute, 24 idle hours). Links last 15 minutes and work once; at most 5 are created per customer per hour and only the 2 newest unused ones stay valid; every failure to redeem one is the same `401`. Only the SHA-256 of a link or session token is stored. Mutations authenticated by the cookie (and both unauthenticated `/customer-auth` POSTs) need the `X-Requested-By: reviewer-console` header.

**Access.** A conversation is readable, writable and streamable only by the customer it belongs to (or a reviewer); another customer, an anonymous caller and an unknown id all get the same `401`. `GET /my/conversations` lists the caller's own, including ones created before login mode. A customer is never a reviewer: `/approvals`, `/customers`, `/events` and the other reviewer routes are `401` for them, and their view of a conversation omits the policy, notification and four-eyes fields. In login mode conversation tokens are no longer accepted, and the open demo (no reviewer, no key) does not let an anonymous caller into conversations (reviewer routes stay open there, and the API warns at startup). If both a reviewer cookie and a customer cookie are present, the reviewer wins.

**Mail.** Set `LOGIN_SMTP_URL` and `LOGIN_EMAIL_FROM` (checked like the notification SMTP settings: remote hosts need STARTTLS, no credentials in other URLs, nothing is logged). Login mode refuses to start without them. This sender is separate from the reviewer notification channel, which must carry no customer data.

Limits: the link is as safe as the customer's mailbox; a stolen session cookie is that customer's session until it expires or they sign out; a nuisance caller can use up a customer's hourly link allowance; no sign-up, passwords, MFA or SSO; failed mail is logged, not retried; the SMTP leg has only been exercised once by hand against a local Mailpit catcher (plain SMTP on localhost), never a live provider or the STARTTLS/AUTH path (the tests use nodemailer's JSON transport).

## Reviewer notifications

A reviewer does not have to keep the console open. When the agent parks a risky action, the API pushes one short message to whichever channels you configured: a signed JSON webhook, a Slack incoming webhook, and/or email over SMTP. Code lives in [apps/api/src/notify/](apps/api/src/notify/); the design is in [the spec](docs/superpowers/specs/2026-10-29-reviewer-notifications-design.md).

**Off by default.** A channel is on only when its variables are set. With none set nothing starts and nothing is claimed (`notified_at` stays null), so the API behaves exactly as before. `notified_at` is per approval, not per channel, and it is set when the approval is claimed, even if every channel then fails. So turning a channel on later only affects approvals that have not been announced yet; it does not replay earlier ones.

**All replicas must share one notification configuration.** The replica that claims an approval decides which channels get it, so a replica with a missing or wrong channel, or a rolling deploy that adds a channel, can consume approvals without sending them to the new channel.

| Variable | Default | Description |
| --- | --- | --- |
| `NOTIFY_WEBHOOK_URL` | _(unset)_ | Generic JSON webhook. Must be `https://`; plain `http://` is accepted only for `localhost`, `127.0.0.1` and `[::1]` |
| `NOTIFY_WEBHOOK_SECRET` | _(unset)_ | Signs each webhook request (see below). Without it the request carries no signature headers. Setting it without `NOTIFY_WEBHOOK_URL` stops the API at startup |
| `NOTIFY_SLACK_WEBHOOK_URL` | _(unset)_ | Slack incoming-webhook URL, same `https` / localhost rule |
| `NOTIFY_SMTP_URL` | _(unset)_ | `smtp://` or `smtps://` URL with a host, credentials included, e.g. `smtps://user:pass@smtp.example.com:465`. See [SMTP details](#smtp-details) |
| `NOTIFY_EMAIL_FROM` | _(unset)_ | Sender: one plain address like `alerts@example.com` (no display name) |
| `NOTIFY_EMAIL_TO` | _(unset)_ | Comma-separated plain addresses; one message goes to all of them |
| `REVIEWER_CONSOLE_URL` | `http://localhost:3000/reviewer` | The link put in every message; any `http(s)` URL without a username or password |

The three email variables go together: set all or none, otherwise the API stops at startup. Every value is checked at startup and a bad one stops the API; the error names the variable, never its value, because these URLs can carry secrets. Values are trimmed, and empty or whitespace-only ones count as unset, so a copied `.env.example` is fine. The webhook, Slack and console URLs must not contain a username or password.

#### SMTP details

- Credentials go in the URL's userinfo and must be percent-encoded: write `@` as `%40`, `#` as `%23` and `:` as `%3A` in a password.
- The URL must have a host, and no query string or fragment is allowed (nodemailer would copy query keys such as `?debug=true` or `?tls.rejectUnauthorized=false` into its options and override the hardened settings).
- A remote `smtp://` host requires STARTTLS (`requireTLS`), so the connection cannot be silently downgraded to plaintext before AUTH; if the server does not offer it, the send fails. `smtp://` to `localhost`, `127.0.0.1` or `[::1]` does not require it, which keeps a local dev mail catcher working. `smtps://` uses TLS from the start.
- Remote or internal plaintext relays that do not offer STARTTLS (for example `smtp://mailpit:1025` in a Docker network) cannot be used; point the API at a relay that offers STARTTLS, use `smtps://`, or use `localhost`.
- The per-attempt allowance for email is 20 s (other channels 5 s), because a slow handshake plus AUTH and DATA can take longer than 5 s. Even so, a very slow server can still deliver an attempt the notifier has given up on, which can mean a duplicate email.

### What triggers a notification

- an `approvals` event on the stream bus (a burst is throttled into one check, 200 ms after the first event), or a `resync` event;
- one check when the API starts;
- a sweep every 60 s, as a safety net if a bus signal was missed.

Each check **claims** pending approvals that have not been announced yet: it sets `actions.notified_at` in one statement with `FOR UPDATE SKIP LOCKED`, and that commits before anything is sent. The claim never hands out the same approval twice, so no second process re-announces it (a slow receiver can still see a retry duplicate; see Limits). Only approvals still `pending_approval` are claimed, so a decision or an expiry does not send anything. Checks never overlap within a process, and a pass handles up to 5 approvals at a time, repeating while a pass comes back full.

### What is sent

Every channel gets the same small summary, built in one place ([note.ts](apps/api/src/notify/note.ts)) from an allowlist of fields. The webhook body is shown here pretty-printed; the real body is compact JSON, so verify the signature against the raw bytes you received, not a re-serialised copy:

```json
{
  "event": "approval.requested",
  "approval": {
    "id": "3f0c2c52-8f0e-4a63-9a53-3f1d2d1b7c11",
    "tool": "issue_refund",
    "orderId": 1,
    "amount": 18.75,
    "rule": "over_threshold",
    "createdAt": "2026-10-29T09:15:02.481Z",
    "consoleUrl": "http://localhost:3000/reviewer"
  }
}
```

`orderId`, `amount` and `rule` are left out when the value is missing or malformed, and `amount` appears only for `issue_refund`. **Deliberately never sent:** customer name, email, the customer's message, the conversation id, the refund or cancellation reason, the agent's reasoning, and the rest of the tool arguments. Open the console to read those.

- **Webhook:** `POST` with `Content-Type: application/json` and the body above. Redirects are not followed (a 3xx counts as a failed attempt).
- **Slack:** one line, e.g. `Approval needed: refund $18.75 on order #1 (rule: over_threshold) - <link|Open the reviewer console>`.
- **Email:** a plain-text message (no HTML) with the subject `Approval needed: refund $18.75 on order #1`, the rule, the request time and the console link.

### Verifying the webhook signature

With `NOTIFY_WEBHOOK_SECRET` set, each request carries two extra headers:

```
x-timestamp: <unix seconds>
x-signature: sha256=<hex>
```

where `<hex>` is the hex HMAC-SHA256, keyed with the secret, of the string `"<x-timestamp>.<raw body>"`. Compute it over the raw request bytes, before any JSON parsing, and compare in constant time:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

// secret:    your NOTIFY_WEBHOOK_SECRET
// timestamp: the x-timestamp header, as received (unix seconds)
// signatureHeader: the x-signature header
// rawBody:   the request body exactly as received (Buffer or string), before JSON parsing
const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'));
const received = Buffer.from(signatureHeader);
const ok = received.length === expected.length && timingSafeEqual(received, expected); // timingSafeEqual throws on unequal lengths
```

Because the timestamp is signed, **also reject requests whose `x-timestamp` is too old** (say, more than five minutes) so a captured request cannot be replayed later, **and too far in the future**, so a request stamped ahead of time cannot be held back and replayed.

### Delivery and retries

Each attempt has a 5 s timeout (20 s for email); anything but a 2xx response, or any error, is a failed attempt. A channel gets 3 attempts, waiting 1 s and then 4 s between them. After the third failure the API logs one line, `Notification via <channel> failed for approval <id>: <short reason>`, and gives up. The line never contains a URL, a secret, a response body or the SMTP error text. Channels retry independently, so a failing Slack does not hold back the webhook for the same approval.

### Limits

- **At most once.** The claim commits before delivery, so a notification that fails all three attempts is not sent again, neither is one in flight when the process is killed, and neither is one whose rows never came back because the database connection dropped after the claim committed. It still shows in the console, which is the source of truth. A graceful shutdown (`SIGTERM`) gives back the approvals it had claimed but not yet started on, and the next process announces them; one whose delivery had begun counts as attempted and is not released (it gets no further retries once shutdown begins). Shutdown waits for an attempt already in flight, up to 5 s (20 s for email), so give the container a stop grace period longer than that; if it is killed first, the unstarted approvals are not released. A hard kill between the claim and the send loses the notifications of that batch: up to 5 approvals, not just one.
- **A duplicate is still possible.** A send abandoned after its timeout (5 s, 20 s for email) may complete on the receiver's side and then be retried. Have receivers dedupe on the approval `id`.
- **One slow channel can delay others.** The channels of one approval run in parallel, but approvals are delivered one at a time, so a dead channel (about 20 s per approval, and up to about 65 s for email) can delay later notifications.
- **Delay.** Normally the message goes out within moments of the approval being parked. If the bus signal is missed, the 60 s sweep is the worst case, plus any time spent behind slow deliveries.
- **Pending approvals only.** There are no decision or expiry notifications, no reminders or escalation, and no per-reviewer routing: an approval goes to the channels configured on the replica that claims it, once (see the note on shared configuration above).
- `GET /approvals` and the reviewer view of a conversation include `notifiedAt` (when the approval was claimed for announcing; null while unclaimed). It is hidden from customers only when `REVIEWER_API_KEY` is set; in demo mode (no key) everyone is treated as a reviewer.

Test coverage: the channels are covered by unit tests with fakes (the email channel through nodemailer's JSON transport, the others with a fake `fetch`), and the webhook additionally by an end-to-end test against Postgres and a local receiver. They have **not** been exercised against a real Slack workspace or SMTP server, so try yours with a test approval (see the quick start) before relying on it.

## Configuration

One root `.env` (see [.env.example](.env.example)); everything is optional.

| Variable | Default | Description |
| --- | --- | --- |
| `DB_PORT` | `5432` | Host port for the Postgres container |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `postgres` / `postgres` / `aiagent` | Database credentials |
| `DATABASE_URL` | built from the above | Full connection string override |
| `API_PORT` | `3001` | NestJS port (1-65535) |
| `API_URL` | `http://localhost:3001` | Where Next.js proxies `/api/*` |
| `REVIEWER_API_KEY` | _(unset)_ | If set (and no reviewer account exists), reviewer routes require `Authorization: Bearer <key>` and conversations require their access token; unset = open demo mode. Ignored once a reviewer account exists |
| `AGENT_MAX_STEPS` | `8` | Max model calls per run (positive integer; invalid values stop the API at startup) |
| `CONVERSATION_TOKEN_BUDGET` | `200000` | Max tokens (input + output) per conversation; after that the agent stops calling the model and the run ends `budget_exceeded`. A soft cap: the call that crosses it still completes |
| `CONTEXT_MAX_TOKENS` | `8000` | Rough cap on the history sent per model call. Whole old turns are left out (the model is told); the stored trace is never trimmed |
| `APPROVAL_TTL_MINUTES` | `1440` | Pending approvals older than this are auto-rejected and the agent tells the customer. `0` = never |
| `REFUND_AUTO_APPROVE_UNDER` | `0` | Dollars. A refund is approved automatically (and logged as `auto_approved`) when it plus earlier refunds on the same order stays strictly under this amount. `0` = every refund waits for a reviewer. Does not apply to cancellations, which always wait |
| `FOUR_EYES_REFUND_OVER` | `0` | Dollars. A refund of strictly more than this needs two different reviewers. `0`/unset = off. Needs reviewer accounts |
| `FOUR_EYES_CANCELLATIONS` | `false` | `true` makes every cancellation need two reviewers. Only `true` or `false` are accepted (anything else stops the API at startup) |
| `SESSION_TTL_HOURS` | `12` | Absolute lifetime of a reviewer session (positive integer); sessions also end after 30 idle minutes |
| `COOKIE_SECURE` | `true` if `NODE_ENV=production`, else `false` | Adds `Secure` to the session cookie. Set `false` explicitly for a plain-HTTP deployment |
| `RATE_LIMIT_LOGIN_PER_MINUTE` | `10` | Per-client limit on `POST /auth/login` |
| `CUSTOMER_LOGIN` | `false` | `true` turns on customer sign-in by emailed link (see [Customer login](#customer-login)); only `true` or `false` are accepted. Needs `LOGIN_SMTP_URL` and `LOGIN_EMAIL_FROM` |
| `LOGIN_SMTP_URL`, `LOGIN_EMAIL_FROM` | _(unset)_ | The mail server and sender for sign-in links; both or neither (required when `CUSTOMER_LOGIN=true`) |
| `CUSTOMER_APP_URL` | `http://localhost:3000` | Where the emailed link points (the customer web app), without a trailing slash |
| `CUSTOMER_SESSION_TTL_DAYS` | `7` | Absolute lifetime of a customer session (positive integer); sessions also end after 24 idle hours |
| `RATE_LIMIT_CUSTOMER_LOGIN_PER_MINUTE` | `5` | Per-client limit on `POST /customer-auth/request` and `/verify` |
| `RATE_LIMIT_PER_MINUTE` | `600` | Per-client limit across the API (`/health` is exempt) |
| `RATE_LIMIT_START_PER_MINUTE` / `RATE_LIMIT_MESSAGES_PER_MINUTE` | `10` / `20` | Stricter per-client limits on `POST /conversations` and `POST /conversations/:id/messages` |
| `CORS_ORIGINS` | _(empty)_ | Comma-separated exact origins allowed to call the API from a browser. Empty = none |
| `TRUST_PROXY` | `0` | Proxy hops whose `X-Forwarded-For` is trusted for client identity (see Security notes) |
| `STREAM_MAX_PER_CONVERSATION` | `5` | Max concurrent SSE streams per conversation; more get `429` |
| `STREAM_MAX_REVIEWER` | `20` | Max concurrent reviewer-console SSE streams; more get `429` |
| `NOTIFY_WEBHOOK_URL`, `NOTIFY_WEBHOOK_SECRET` | _(unset)_ | Reviewer notifications: signed JSON webhook (https, or http for localhost) and its optional signing secret. See [Reviewer notifications](#reviewer-notifications) |
| `NOTIFY_SLACK_WEBHOOK_URL` | _(unset)_ | Reviewer notifications: Slack incoming-webhook URL |
| `NOTIFY_SMTP_URL`, `NOTIFY_EMAIL_FROM`, `NOTIFY_EMAIL_TO` | _(unset)_ | Reviewer notifications by email; all three or none. `NOTIFY_EMAIL_TO` is comma-separated |
| `REVIEWER_CONSOLE_URL` | `http://localhost:3000/reviewer` | Link put in every notification |
| `LLM_PROVIDER` | `mock` | `mock` \| `openai` \| `anthropic` |
| `LLM_MAX_RETRIES` | `2` | Extra attempts for network errors, `408`, `429` and `5xx` from the provider (exponential backoff with jitter; honours `Retry-After`, but never waits longer than 30 s). `0` = off |
| `LLM_MAX_TOKENS` | _(unset)_ | Output cap per model call; reasoning tokens count against it. Unset = Anthropic `4096`, OpenAI the model's own limit. A response cut off by the cap fails the run instead of being used |
| `MOCK_DELAY_MS` | `150` | Artificial mock latency so the live trace is visible |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` | – / `gpt-4o-mini` / OpenAI URL | OpenAI (or compatible) settings |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | – / `claude-sonnet-5-5` | Anthropic settings |

## Testing

```bash
npm run typecheck
npm test                                  # API unit tests, then web unit tests; e2e is skipped without a DB URL
E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5432/aiagent npm test   # + e2e
```

- **Unit (Jest):** tool schema validation, guardrail rules (cross-customer access and over-refund blocked, cancellation allowed only for a `processing` order with no refunds), the approval policy, provider adapters (including real-HTTP contract tests against a local server), and the agent loop with the mock provider: *lookup → refund request → pending approval → approve → refund recorded*, plus rejection, step limit, unknown tools and provider failure.
- **Cancel and track e2e:** `cancel-track` runs `cancel_order` and `track_shipment` through the agent over HTTP against real Postgres: approve and reject, the guardrail refusals that park nothing, cross-customer access, a replayed approval, cancellations still going to a human with a very high `REFUND_AUTO_APPROVE_UNDER`, and the customer's view of a parked cancellation. `shop-cancel` tests `cancelOrder` directly, including a cancel racing a refund and deterministic row-lock tests that hold the order lock from a second connection.
- **Stream unit (Jest):** `StreamBus` (fan-out, reconnect with one `resync`, listener heartbeat, shutdown) and `eventStream` (filtering, cap, ping, cleanup).
- **Web unit:** the SSE parser and the fetch-based stream client (status changes, reconnect with backoff, idle detection, close), and the refresh helpers (latest-wins, single-flight). `npm test` at the root runs the API suite and then the web suite (`node:test` through `tsx`, no extra test framework).
- Jest runs test files one at a time (`maxWorkers: 1`) because the e2e suites share one database.
- **E2E:** the same approval flow over HTTP against real Postgres, plus input validation, reviewer-key and conversation-token access rules, the approval-time balance re-check and the `502` mapping. **It re-seeds the target database**, so point it at a disposable one.
- **Stream e2e:** against real Postgres, `/events` and `/conversations/:id/events` deliver `trace` / `approvals` / `audit` to the right audience only, refuse bad credentials and malformed ids, enforce the caps (including for a differently-cased id), publish nothing for a rolled-back write, send `resync` after the `LISTEN` backend is killed, and end promptly on `app.close()`.
- **Notifications (Jest):** config validation, the note builder's allowlist (including hostile tool arguments), the webhook signature, Slack escaping, the email message (against nodemailer's JSON transport, no SMTP server), retry timing (with an injected sleep recorder; fake timers only in the debounce and sweep tests), timeouts and log redaction with fake channels, non-overlapping passes, and release on shutdown.
- **Notifications e2e:** against real Postgres, claims are handed out once and never overlap between concurrent claimers; a signed webhook reaches a local receiver exactly once per parked approval (also with two replicas) and carries none of the customer's data; a decision sends nothing; a failing receiver is retried three times and logged without its URL; shutdown releases rows it had not started; nothing is claimed with no channel configured; `notifiedAt` is hidden from customers (with a reviewer key set).
- **Accounts (Jest):** password hashing (format, tampered or absurd parameters, length bounds), config parsing, principal resolution in every mode, login uniformity and lockout, the cookie and CSRF helpers, the first-admin command's argument rules, and the four-eyes policy table and runner flow with in-memory fakes (first approval keeps it pending, same reviewer refused, second reviewer executes once, reject, deactivated approver not counted, key caller refused, expiry, retry after a failed execution).
- **Accounts e2e:** against real Postgres, the reviewer store (sessions, expiry, idle, lockout counters under concurrency, the last-admin lock), login/logout/cookie attributes, uniform `401`s, session end on deactivation and password change, CSRF on every mutating cookie route, the shared key being ignored once a reviewer exists, `/events` with the cookie, admin routes, no secrets in any response, and four-eyes over HTTP (one reviewer's repeat, a nine-reviewer race that must execute once, reject, deactivation, expiry, cancellations, the customer's view, audit names).
- **Web unit:** also the proxy (forwards the cookie and `X-Requested-By`, returns every `Set-Cookie`), the CSRF header on the API client, and the approval-progress helpers.
- **Customer login:** unit tests for the link and session lifecycle (expiry, idle, single use, keep-newest-2, hourly cap, mail failure and no leak into logs, answered before the mail is sent), the principals (a customer is not a reviewer), the principal middleware order, CSRF for customer cookies, the mail sender and the config. E2E against real Postgres: link and session store semantics (concurrent races for single use and for the hourly cap), the routes (uniform `202` and `401`, cookie attributes, CSRF, rate limit, logout and logout-all), and cross-customer access to every conversation route and stream, the open-demo and reviewer-wins cases, and login off changing nothing. Web: the fragment reader, the screen helper and the CSRF header on the customer calls.
- CI runs typecheck, tests (with a Postgres service container) and build on every push.

Regenerate the README screenshots with the stack running: `npm run screenshot` (needs `npx playwright install chromium` once).

## Security notes

This is a **starter, not a production service**. What is and isn't protected:

- **Reviewer routes** (`/approvals`, `/customers`, listing all conversations) need a reviewer: a session cookie once reviewer accounts exist, otherwise `Authorization: Bearer <REVIEWER_API_KEY>` when that variable is set (constant-time compare, `401` otherwise). In key mode the console asks for the key and keeps it in that tab's `sessionStorage`; in accounts mode the credential is an `HttpOnly` cookie that page scripts cannot read. The Next.js proxy holds no secrets and forwards the cookie and `X-Requested-By` exactly as the browser sent them.
- **Conversations are capability-protected.** `POST /conversations` returns a random `accessToken` once; only its SHA-256 hash is stored. Reading or posting to a conversation needs that token (or the reviewer key; with `CUSTOMER_LOGIN=true`, the owning customer's session instead, see [Customer login](#customer-login)), and unknown ids and wrong tokens are both `401`, so ids can't be probed. The customer page keeps its tokens in `localStorage`.
- **Demo mode is open.** With no reviewer account and `REVIEWER_API_KEY` unset the API logs a warning and skips all of the above so the zero-config demo works. Create a reviewer (or set the key) for anything beyond a local demo.
- **Who may start a conversation.** With `CUSTOMER_LOGIN=true` the customer comes from a verified session (a magic link emailed to the account address), never from the request body; see [Customer login](#customer-login). Without it (the default) the original caveat stands: there is no customer login, so anyone can start a conversation as any customer by `customerId` or account email. The guardrails bind *the agent* to that customer; they can't prove *the caller is* that customer. Turn login on (and use a reviewer account or key) before using real data.
- **Reviewer identity.** With accounts, every decision names the reviewer (id and name) and four-eyes can require two different people. Without accounts (demo or key mode) the log still cannot say which reviewer decided. Reviewer-management actions (adding, deactivating, resetting a password) are written to the application log with actor and target ids, not to the audit table, and never contain a password.
- **Accounts: what is protected and what is not.** Passwords are scrypt hashes; session tokens are stored only as SHA-256; no hash, lockout counter or token appears in a response, a log line or a validation error. Account lockout can be used to lock a known email out for 15 minutes (a known trade-off; the failures still answer `401`). There is no email-based password reset (an admin sets a new password), no MFA, no SSO, and scrypt parameters are not upgraded on login. Sessions are server-side rows, so there is no stateless token to revoke.
- Upstream LLM error bodies are logged server-side only and never returned to clients.
- **HTTP hardening.** `helmet` sets standard security headers, CORS is off unless `CORS_ORIGINS` lists exact origins, and requests are rate limited per client (`429` with `Retry-After`), most tightly on starting conversations and sending messages since those cost LLM calls.
- **Client identity behind proxies.** Rate limits key on the client address. Without `TRUST_PROXY` that is the socket peer, so behind the bundled Next.js proxy every customer shares one bucket (fine for a demo, too coarse for production). Set `TRUST_PROXY=1` only when a trusted load balancer in front sets `X-Forwarded-For`; if the proxy is directly exposed, clients can spoof the header.
- **Cost controls.** Each conversation has a token budget, the history sent to the model is capped, and `GET /conversations/:id` reports `usage` per run and per conversation. Failed runs show customers a generic error; reviewers see the real one.
- **Approvals expire.** Pending approvals are auto-rejected after `APPROVAL_TTL_MINUTES`. The sweep runs in-process every minute, so it assumes a single API instance.
- **Cancellations are never auto-approved.** The `cancel_order` rule is `tool_requires_review`, so `REFUND_AUTO_APPROVE_UNDER` has no effect on it and every request waits for a reviewer.
- **Both new tools check ownership.** `track_shipment` and `cancel_order` load the order and refuse (`CROSS_CUSTOMER`) one that belongs to another customer, so a shipment is never returned for someone else's order. A cancellation request is also refused up front, before it is parked, if the order is not `processing` or has refunds (`NOT_CANCELLABLE`, `ALREADY_CANCELLED`, `HAS_REFUNDS`).
- **Cancel and refund share the order row lock.** `cancelOrder` and `createRefund` both `SELECT … FOR UPDATE` the order and re-check ownership and state inside that transaction, so a cancel and a refund on one order cannot interleave: whichever commits second is refused (a refund on a cancelled order is `ORDER_CANCELLED`).
- **Cancellations are replay-safe.** The approval's id is stored on the order as `cancel_action_id` (unique, and never returned to the model). Re-running an approval whose cancellation already committed, as crash recovery or a reviewer retry can, reports the cancellation again instead of failing or cancelling twice.
- **Auto-approval is opt-in and cumulative.** With `REFUND_AUTO_APPROVE_UNDER` unset nothing is auto-approved. When set, the check counts earlier refunds on the order, so a large refund cannot be split into small ones; it does not cap refunds across a customer's different orders. The check is not atomic: two conversations of the same customer refunding the same order at the same instant can both pass it and briefly exceed the threshold, but the over-refund guard in `createRefund` still caps the total at the order total. The `auto_approved` event records the policy decision and is written before the refund runs; the refund does not run if the event cannot be written. If a guardrail inside `createRefund` then rejects the call, the log shows an auto-approval with no refund behind it.
- **Audit log.** `approval_events` is append-only and written in the same transaction as the decision it records. If execution fails after a reviewer's decision is claimed and the reviewer retries, the log shows two decision rows for that one action; the history stays accurate rather than being rewritten. In the reviewer console the **Audit log** tab shows these events, and pending approval cards carry a short "why a human is needed" hint (reviewers only).
- **Streams use the same auth as the REST API.** `/conversations/:id/events` needs the conversation token (or the customer's session in login mode, or a reviewer) and `/events` needs a reviewer: the key or the session cookie, sent as headers, never in a URL. The same guards run before the stream opens, so a bad credential is an ordinary `401`. Events carry no content (only a kind and a conversation id), customers never receive `approvals` or `audit` signals, and streams are capped per conversation and for the reviewer (`429`).
- **Customers never see the policy.** The customer view of `GET /conversations/:id` omits the policy fields (`policyRule`, `policyDetail`) and the four-eyes progress (`approvalsRequired`, `approvalsGiven`, `approvedBy`, `approvedByIds`), so the threshold, the rule that applied and who approved are visible to reviewers only.
- **Crash recovery.** If the process dies after a reviewer's decision is claimed but before it is carried out, the same minute-by-minute pass finishes it once the claim is five minutes old (even with expiry disabled). Refunds are idempotent per approval, so a refund that had already committed is never paid twice, and a cancellation that had already committed is not repeated.
- **Input limits.** Messages are trimmed, must be 1-2000 characters, and may not contain NUL (Postgres text cannot hold it); tool ids are bounded to the database's integer range. Bad values are a `400` at the edge instead of a failed run.
- **Notifications carry no customer data.** Messages hold an approval id, tool, order id, refund amount, policy rule, time and the console link, never names, emails, messages or reasons. Webhook, Slack and SMTP URLs are validated at startup and never appear in logs or error messages. Webhooks are `https` only (plain `http` for localhost), are not redirected, and are HMAC-signed when `NOTIFY_WEBHOOK_SECRET` is set. This is not a full SSRF defence: the operator controls these values. Delivery is at most once (see [Reviewer notifications](#reviewer-notifications)).
- **Provider replies.** A body that is not JSON, one cut off mid-read, or an empty model reply becomes a `502` and a failed run (an empty reply is kept in the trace, flagged `EMPTY_RESPONSE`, with its tokens counted, but never replayed to the model).

## Known limitations

- **Events are hints, not a log.** There is no replay and no `Last-Event-ID` (the per-connection `id:` the server adds is ignored); a client that was disconnected just refetches.
- **No token-by-token text.** A model reply appears whole when its step is saved.
- **Stream caps are per process**, so with several API replicas the effective cap is multiplied.
- **There is no global cap on open streams.** Only the per-conversation and reviewer caps exist, and `POST /conversations` is unauthenticated (though throttled), so a client can open many conversations and hold a stream on each.
- **Many tabs can queue requests on plain HTTP/1.1.** Each open tab holds one of a browser's ~6 connections per host for its stream, so with many tabs other requests may wait for a free one. HTTP/2 avoids this.
- **Customer login browser check.** The sign-in form, the emailed link's landing page, a chat as the signed-in customer, reload, log out and a reused link were checked by hand in Chrome against a throwaway database with the mock LLM. The "Sign out everywhere" button, the phone layout and a real mail provider were not (the API side is covered by tests).
- **The manual browser check is not automated.** The live-update UI (the top-bar chip, chat and console refresh, the polling fallback) and the reviewer login UI have no browser test, so check them by hand after changing them. When the accounts console was built, sign-in, the live stream under the cookie, "0 of 2" to "1 of 2 approvals" with Approve disabled for the approver, and log out were checked by hand in Chrome against a throwaway database; the Reviewers tab actions, the change-password dialog and a second reviewer completing an approval in the browser were not (the API behaviour is covered by tests).
- **An open event stream is authenticated when it opens.** If the reviewer's session ends or they are deactivated while `/events` is open, that stream keeps delivering signals until it closes (they carry only an event kind and a conversation id, no content) and the console falls back to its normal `401` handling on the next fetch.
- **Two account details are per process.** The "any reviewers?" answer is cached in each API process (up to 5 s to notice a first reviewer created elsewhere), and the per-client request limits, including the login limit, are counted in memory. The account lockout counter is in the database, so it holds across replicas.
- **`LISTEN` needs a session-mode Postgres connection.** A transaction-pooling proxy such as PgBouncer in transaction mode breaks it (notifications are not delivered). Point `DATABASE_URL` at Postgres directly, or at a session-mode pool.

## Next steps

- Stream model tokens as they are generated (SSE currently only signals saved changes).
- Run steps as a background job (queue) so long agent runs don't hold an HTTP request open.
- Prompt-injection and eval suites; replay recorded traces against new prompts or models.
- Per-tool rate limits and spend budgets across conversations (per-conversation token budgets exist).
- Real migrations (the schema is idempotent DDL applied on boot) and multi-tenant data.

## License

[MIT](LICENSE) © Kevin Makwana. "Acme Shop" and all data are fictional.
