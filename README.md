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
| `POST /conversations` | Create a conversation bound to `{ customerId }` or `{ email }`; returns the conversation plus its one-time `accessToken` |
| `GET /conversations` | 🔒 reviewer: list all conversations (with pending-approval counts) |
| `GET /conversations/:id` | 🔑 Full trace: runs → steps, plus approvals and token `usage` (per run and per conversation, with the budget) |
| `POST /conversations/:id/messages` | 🔑 Send `{ content }`; runs the agent until it answers or pauses (`409` while another run is in progress or an approval is pending) |
| `GET /conversations/:id/events` | 🔑 SSE stream of `trace` signals for one conversation (`429` over `STREAM_MAX_PER_CONVERSATION`) |
| `GET /approvals?status=pending` | 🔒  List approvals (`pending` \| `approved` \| `rejected` \| `all`) with customer, order (total, refunded so far, current `orderStatus`) and reasoning context |
| `GET /approvals/events` | 🔒 Append-only audit log of approval decisions, newest first (`conversationId`, `limit` up to 200, `before` event id). Kinds: `requested`, `auto_approved`, `approved`, `rejected`, `expired` |
| `POST /approvals/:id` | 🔒 `{ decision: "approve" \| "reject", note? }`; executes the parked call and resumes the run (`409` if already decided) |
| `GET /events` | 🔒 SSE stream of `trace` / `approvals` / `audit` signals for the reviewer console (`429` over `STREAM_MAX_REVIEWER`) |
| `GET /customers` | 🔒 Customers for the demo picker (extra) |
| `GET /health` | API + database + active provider + whether reviewer auth is on |

🔒 = reviewer key (`Authorization: Bearer <REVIEWER_API_KEY>`). 🔑 = the conversation's `X-Conversation-Token`, or the reviewer key. Both are open when `REVIEWER_API_KEY` is unset (demo mode).

Events are signals only (`{ "conversationId": "…" }`, no content; `resync` carries `{}`): clients refetch the normal endpoints to see what changed. The client sends its credential in headers (a `fetch`-based reader, not `EventSource`, which cannot set headers), and every connect is followed by a refetch.

Validation uses `class-validator` with `whitelist` + `forbidNonWhitelisted` (unknown fields → `400`). Upstream LLM failures return `502` with a clear message and mark the run `failed`. A failed run's stored error is shown verbatim only to reviewers; customers get a generic message.

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
// timestamp: the x-timestamp header, as received
// rawBody:   the request body exactly as received (Buffer or string), before JSON parsing
const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'));
const received = Buffer.from(signatureHeader); // the x-signature header
const ok = received.length === expected.length && timingSafeEqual(received, expected); // timingSafeEqual throws on unequal lengths
```

Because the timestamp is signed, **also reject requests whose `x-timestamp` is too old** (say, more than five minutes) so a captured request cannot be replayed later, **and too far in the future**, so a request stamped ahead of time cannot be held back and replayed.

### Delivery and retries

Each attempt has a 5 s timeout (20 s for email); anything but a 2xx response, or any error, is a failed attempt. A channel gets 3 attempts, waiting 1 s and then 4 s between them. After the third failure the API logs one line, `Notification via <channel> failed for approval <id>: <short reason>`, and gives up. The line never contains a URL, a secret, a response body or the SMTP error text. Channels retry independently, so a failing Slack does not hold back the webhook for the same approval.

### Limits

- **At most once.** The claim commits before delivery, so a notification that fails all three attempts is not sent again, neither is one in flight when the process is killed, and neither is one whose rows never came back because the database connection dropped after the claim committed. It still shows in the console, which is the source of truth. A graceful shutdown (`SIGTERM`) gives back the approvals it had claimed but not yet started on, and the next process announces them; one whose delivery had begun counts as attempted and is not released (it gets no further retries once shutdown begins). A hard kill between the claim and the send loses the notifications of that batch: up to 5 approvals, not just one.
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
| `REVIEWER_API_KEY` | _(unset)_ | If set, reviewer routes require `Authorization: Bearer <key>` and conversations require their access token; unset = open demo mode |
| `AGENT_MAX_STEPS` | `8` | Max model calls per run (positive integer; invalid values stop the API at startup) |
| `CONVERSATION_TOKEN_BUDGET` | `200000` | Max tokens (input + output) per conversation; after that the agent stops calling the model and the run ends `budget_exceeded`. A soft cap: the call that crosses it still completes |
| `CONTEXT_MAX_TOKENS` | `8000` | Rough cap on the history sent per model call. Whole old turns are left out (the model is told); the stored trace is never trimmed |
| `APPROVAL_TTL_MINUTES` | `1440` | Pending approvals older than this are auto-rejected and the agent tells the customer. `0` = never |
| `REFUND_AUTO_APPROVE_UNDER` | `0` | Dollars. A refund is approved automatically (and logged as `auto_approved`) when it plus earlier refunds on the same order stays strictly under this amount. `0` = every refund waits for a reviewer. Does not apply to cancellations, which always wait |
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
- CI runs typecheck, tests (with a Postgres service container) and build on every push.

Regenerate the README screenshots with the stack running: `npm run screenshot` (needs `npx playwright install chromium` once).

## Security notes

This is a **starter, not a production service**. What is and isn't protected:

- **Reviewer routes** (`/approvals`, `/customers`, listing all conversations) require `Authorization: Bearer <REVIEWER_API_KEY>` once that variable is set (constant-time compare, `401` otherwise). The reviewer console at `/reviewer` asks for the key and keeps it in that tab's `sessionStorage`; the Next.js proxy holds no secrets.
- **Conversations are capability-protected.** `POST /conversations` returns a random `accessToken` once; only its SHA-256 hash is stored. Reading or posting to a conversation needs that token (or the reviewer key), and unknown ids and wrong tokens are both `401`, so ids can't be probed. The customer page keeps its tokens in `localStorage`.
- **Demo mode is open.** With `REVIEWER_API_KEY` unset the API logs a warning and skips all of the above so the zero-config demo works. Set the key for anything beyond a local demo.
- **Still not solved: who may start a conversation.** There is no customer login, so anyone can start a conversation as any customer by `customerId` or account email. The guardrails bind *the agent* to that customer; they can't prove *the caller is* that customer. Plug in a real identity provider (derive the customer from the session, not the body) before using real data.
- **Reviewer identity is one shared key**: no per-reviewer accounts, no four-eyes rule (approver ≠ requester). Decisions are logged, but the log does not say *which* reviewer decided.
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
- **Streams use the same auth as the REST API.** `/conversations/:id/events` needs the conversation token (or reviewer key) and `/events` needs the reviewer key, sent as headers, never in a URL. The same guards run before the stream opens, so a bad credential is an ordinary `401`. Events carry no content (only a kind and a conversation id), customers never receive `approvals` or `audit` signals, and streams are capped per conversation and for the reviewer (`429`).
- **Customers never see the policy.** The customer view of `GET /conversations/:id` omits the policy fields (`policyRule`, `policyDetail`), so the threshold and the rule that applied are visible to reviewers only.
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
- **The manual browser check is not automated.** The live-update UI (the top-bar chip, chat and console refresh, the polling fallback) has no browser test, so check it by hand after changing it.
- **`LISTEN` needs a session-mode Postgres connection.** A transaction-pooling proxy such as PgBouncer in transaction mode breaks it (notifications are not delivered). Point `DATABASE_URL` at Postgres directly, or at a session-mode pool.

## Next steps

- Stream model tokens as they are generated (SSE currently only signals saved changes).
- Real identity: customer login (so the customer comes from a session, not the request body), per-reviewer accounts, and four-eyes approval (see Security notes); decisions are already logged, but the log does not yet say *which* reviewer decided.
- Run steps as a background job (queue) so long agent runs don't hold an HTTP request open.
- Prompt-injection and eval suites; replay recorded traces against new prompts or models.
- Per-tool rate limits and spend budgets across conversations (per-conversation token budgets exist).
- Real migrations (the schema is idempotent DDL applied on boot) and multi-tenant data.

## License

[MIT](LICENSE) © Kevin Makwana. "Acme Shop" and all data are fictional.
