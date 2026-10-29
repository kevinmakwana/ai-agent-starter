# Reviewer Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the agent parks a risky action for human approval, push exactly one short, PII-free notification to each configured channel (signed webhook, Slack, email).

**Architecture:** A `Notifier` claims un-announced pending approvals with an atomic `UPDATE … notified_at … SKIP LOCKED` (so replicas and restarts never duplicate), triggered by the 4.1 `StreamBus` (`approvals` / `resync`), a startup pass and a 60 s sweep. Each claimed row becomes a minimal `ApprovalNote` and is delivered to every channel concurrently with 3 attempts, backoff and a per-attempt timeout; failures are logged without secrets. Delivery is at most once.

**Tech Stack:** NestJS 11, `pg`, Node 22 `fetch`/`node:crypto`, `nodemailer` (new dependency), Jest 30.

**Spec:** `docs/superpowers/specs/2026-10-29-reviewer-notifications-design.md`

## Global Constraints

- Branch `phase-4-notifications`, created off `phase-4-more-tools` (stacked: 4.1 → 4.6 → 4.4). Never push or merge.
- e2e tests run ONLY against `E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5435/aiagent_test`; never touch other ports or other projects' containers (the repo `.env` `DB_PORT=5433` belongs to another project). If 5435 does not answer, use a throwaway container on a free high port (55440+) and remove it afterwards.
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Notifications NEVER contain: customer id/name/email, conversation id, messages, `reason`, `reasoning`, or whole `tool_args`. The only allowed note keys are `id, tool, orderId, amount, rule, createdAt, consoleUrl`.
- Logs, errors and thrown messages NEVER contain a webhook URL, SMTP URL, secret or signature. Config error messages name the variable, not its value.
- Webhook URLs: `https:`, or `http:` only for `localhost`, `127.0.0.1`, `[::1]`. `NOTIFY_SMTP_URL`: `smtp:` or `smtps:`.
- Retry: 3 attempts, waits 1000 ms then 4000 ms, 5000 ms timeout per attempt. Debounce 200 ms on bus events, sweep every 60 000 ms (`unref`'d timers).
- With no channel configured nothing runs and no row is claimed.
- Match surrounding style (comment density, naming, idiom). Prefer small focused files under `apps/api/src/notify/`.
- Do not run `next upgrade`.

## Review Focus

- A hanging or slow receiver: must not block the agent run, other channels, or shutdown (timeouts + `stop()` bounded). Test: fake channel that never resolves is aborted by the timeout; `stop()` returns.
- Hostile or odd `tool_args` (non-integer `orderId`, string `amount`, a reason containing an email address, a huge string, markup): the note carries only allowed, validated values. Test in Task 2.
- Secrets in logs: a channel error whose underlying message contains the URL must not reach the log. Test in Tasks 2/4 and e2e.
- Two API replicas on one database, and a burst of events: exactly one notification per approval. Test in Task 5 (two Notifiers, one webhook hit) and Task 4 (coalescing).
- Half-configured email (URL without recipients), a secret without a URL, an `ftp:` or `file:` URL: refused at startup with a clear message. Test in Task 1.

---

### Task 1: Notification config

**Files:**
- Create: `apps/api/src/notify/notify-config.ts`
- Modify: `apps/api/src/config.ts` (add `notify` to `AppConfig` and `loadConfig`), `.env.example`
- Test: `apps/api/src/notify/notify-config.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NotifyConfig {
    webhook?: { url: string; secret?: string };
    slack?: { url: string };
    email?: { smtpUrl: string; from: string; to: string[] };
    /** Link put in every message. */
    consoleUrl: string;
  }
  export const loadNotifyConfig = (env: NodeJS.ProcessEnv): NotifyConfig;
  export const notifyEnabled = (cfg: NotifyConfig): boolean; // any channel set
  ```
  `AppConfig.notify: NotifyConfig`.

- [ ] **Step 1: Write the failing tests** (`notify-config.spec.ts`). Cover, using `loadNotifyConfig(env)` and also one `loadConfig({})` check that `notify` has no channels and `consoleUrl` is `http://localhost:3000/reviewer`:
  - unset → `{ consoleUrl: 'http://localhost:3000/reviewer' }`, `notifyEnabled` false.
  - webhook `https://hooks.example.com/x` + secret OK; `http://localhost:9/x`, `http://127.0.0.1:9/x`, `http://[::1]:9/x` OK; `http://example.com/x`, `ftp://example.com/x`, `file:///etc/passwd`, `not a url` each throw with a message containing `NOTIFY_WEBHOOK_URL` and NOT containing the value that was given (assert on the message of the caught error).
  - same rules for `NOTIFY_SLACK_WEBHOOK_URL`.
  - `NOTIFY_WEBHOOK_SECRET` without `NOTIFY_WEBHOOK_URL` throws (names `NOTIFY_WEBHOOK_SECRET`).
  - email: all of `NOTIFY_SMTP_URL=smtps://u:p@smtp.example.com:465`, `NOTIFY_EMAIL_FROM=alerts@example.com`, `NOTIFY_EMAIL_TO=a@example.com, b@example.com` → `to: ['a@example.com','b@example.com']`; only some of the three → throws naming all three variables; `NOTIFY_SMTP_URL=http://x` throws and the message does not contain `u:p`; a recipient with whitespace/newline inside or without `@` throws (header-injection guard: `"a@example.com\nBcc: x@y.z"`).
  - `REVIEWER_CONSOLE_URL` must be http(s); `ftp://x` throws.
- [ ] **Step 2: Run to see failure:** `npx jest src/notify/notify-config.spec.ts` (from `apps/api`). Expected: cannot find module.
- [ ] **Step 3: Implement** `notify-config.ts`. Use `new URL()`; local hosts via `new Set(['localhost', '127.0.0.1', '[::1]'])` on `url.hostname`. Addresses must match `/^[^\s@,<>"]+@[^\s@,<>"]+$/`. Split `NOTIFY_EMAIL_TO` on commas, trim, drop empties; at least one required. Messages look like `NOTIFY_WEBHOOK_URL must be an https URL (http is allowed only for localhost)`; never interpolate the raw value. Wire `notify: loadNotifyConfig(env)` into `loadConfig` and the `AppConfig` interface (with a one-line doc comment).
- [ ] **Step 4: `.env.example`**: add a commented "Reviewer notifications" block listing `NOTIFY_WEBHOOK_URL`, `NOTIFY_WEBHOOK_SECRET`, `NOTIFY_SLACK_WEBHOOK_URL`, `NOTIFY_SMTP_URL`, `NOTIFY_EMAIL_FROM`, `NOTIFY_EMAIL_TO`, `REVIEWER_CONSOLE_URL`, all empty/commented, in the style of the neighbouring entries.
- [ ] **Step 5: Run** the new spec, `src/config.spec.ts`, and `npm run typecheck` (root). Expected: pass.
- [ ] **Step 6: Commit** `Add notification settings with strict URL and address checks`.

---

### Task 2: Note builder, message formats, webhook and Slack channels

**Files:**
- Create: `apps/api/src/notify/types.ts`, `apps/api/src/notify/note.ts`, `apps/api/src/notify/format.ts`, `apps/api/src/notify/http-post.ts`, `apps/api/src/notify/webhook.channel.ts`, `apps/api/src/notify/slack.channel.ts`
- Test: `apps/api/src/notify/note.spec.ts`, `apps/api/src/notify/channels.spec.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (`types.ts`):
  ```ts
  export interface ClaimedAction {
    id: string; toolName: string; toolArgs: Record<string, unknown>; createdAt: string; rule: string | null;
  }
  export interface ApprovalNote {
    id: string; tool: string; orderId?: number; amount?: number; rule?: string; createdAt: string; consoleUrl: string;
  }
  export interface Channel {
    name: string;
    /** Throws on failure; the message must be safe to log (no URLs, secrets). Honour `signal`. */
    send(note: ApprovalNote, signal: AbortSignal): Promise<void>;
    close?(): void | Promise<void>;
  }
  ```
  `buildNote(row: ClaimedAction, consoleUrl: string): ApprovalNote`; `headline(n): string`, `plainText(n): string`, `slackText(n): string`; `webhookChannel({ url, secret?, fetchFn?, nowSec? }): Channel`; `slackChannel({ url, fetchFn? }): Channel`; `postJson(fetchFn, url, init): Promise<void>` in `http-post.ts`.

- [ ] **Step 1: Failing tests for `buildNote`** (`note.spec.ts`):
  - refund row `{ toolName:'issue_refund', toolArgs:{ orderId: 11, amount: 18.754, reason: 'mail me at ava@example.com' }, rule:'always_review' }` → exactly `{ id, tool:'issue_refund', orderId: 11, amount: 18.75, rule:'always_review', createdAt, consoleUrl }` and `Object.keys` equals the allowed set; the JSON never contains `ava@example.com` or `reason`.
  - cancel row (`cancel_order`, `{ orderId: 11, reason: 'x' }`) → no `amount`.
  - hostile: `orderId: '11; DROP'`, `orderId: 1.5`, `orderId: -3`, `amount: '99'`, `amount: -1`, `amount: Infinity` → those keys omitted; `rule: 'x'.repeat(500)` or `rule: '<b>'` → omitted; `toolName: 'Not Valid!'` → `tool: 'unknown'`; `amount` ignored for non-`issue_refund` tools.
- [ ] **Step 2: Implement** `note.ts` (validators: `orderId` positive safe integer; `amount` finite number > 0 rounded to 2 decimals and only for `issue_refund`; `rule` `/^[a-z_]{1,40}$/`; `tool` `/^[a-z][a-z0-9_]{0,63}$/`).
- [ ] **Step 3: Failing tests for formats and channels** (`channels.spec.ts`), using an injected fake `fetchFn` that records `(url, init)`:
  - `headline`: refund → `refund $18.75 on order #11`; cancel → `cancellation of order #11`; other tool with no order → the tool name; with order → `<tool> on order #N`.
  - `slackText` includes the headline, the rule when present, and `<consoleUrl|Open the reviewer console>`; `& < >` inside values are escaped to `&amp; &lt; &gt;`; any `<`, `>` or `|` in `consoleUrl` is percent-encoded so it cannot break the link.
  - webhook: POSTs JSON `{"event":"approval.requested","approval":{…note}}` with `content-type: application/json`, `redirect: 'manual'` and the given `signal`; without a secret there are no `x-signature`/`x-timestamp` headers; with secret `s3cret` and `nowSec: () => 1_700_000_000` the headers are `x-timestamp: 1700000000` and `x-signature: sha256=<hex>` where hex equals an independently computed `createHmac('sha256','s3cret').update('1700000000.' + body)` (compute in the test).
  - slack: POSTs `{"text": slackText(note)}`.
  - failures: a 500 response → rejects with message `HTTP 500`; a 302 → rejects `HTTP 302`; a fetch that throws `new Error('connect ECONNREFUSED https://hooks.example.com/SECRET')` → rejects with message `request failed` (assert the message does not contain `SECRET`); a fetch that throws a `DOMException`/Error with `name === 'TimeoutError'` or `'AbortError'` → `timed out`. 2xx responses resolve, and the response body is not left unread (call `res.body?.cancel()` in a `finally`, guarded for fakes without a body).
- [ ] **Step 4: Implement** `format.ts`, `http-post.ts` (`postJson` = `fetchFn(url, { method:'POST', headers, body, signal, redirect:'manual' })`, maps errors as above, throws `HTTP <status>` for non-2xx), and the two channels. Defaults: `fetchFn = fetch`, `nowSec = () => Math.floor(Date.now() / 1000)`.
- [ ] **Step 5: Run** both specs and `npm run typecheck`. Expected: pass.
- [ ] **Step 6: Commit** `Add the notification note builder, message formats and webhook and Slack channels`.

---

### Task 3: Email channel and the nodemailer dependency

**Files:**
- Create: `apps/api/src/notify/email.channel.ts`
- Modify: `apps/api/package.json`, root `package-lock.json` (via npm)
- Test: `apps/api/src/notify/email.channel.spec.ts`

**Interfaces:**
- Consumes: `ApprovalNote`, `Channel`, `plainText`, `headline` from Task 2.
- Produces: `emailChannel({ smtpUrl, from, to, transport? }): Channel` with `name: 'email'`, `close()` closing the transport.

- [ ] **Step 1: Verify the library.** Before installing, use Context7 (`resolve-library-id` "nodemailer", then `query-docs`) to confirm: `createTransport({ url, connectionTimeout, greetingTimeout, socketTimeout, dnsTimeout })` accepts a connection URL inside the options object and the timeouts; `jsonTransport: true` yields `info.message` (a JSON string); `transporter.close()`. Run `npm view nodemailer version` and `npm view nodemailer types`; install the current 10.x release (`npm install nodemailer -w apps/api`). Add `@types/nodemailer` only if the package does not ship its own types. Record the installed version in your report. Check `npm ls nodemailer` shows a single copy and `npm audit --omit=dev` raises nothing new for it.
- [ ] **Step 2: Failing tests** (`email.channel.spec.ts`) using `transport: nodemailer.createTransport({ jsonTransport: true })`:
  - `send` produces one message with `from`, all recipients in `to`, subject `Approval needed: refund $18.75 on order #11`, a `text` body containing the tool, order, amount, rule, created time and the console link, and NO `html`.
  - sendMail rejection with `Object.assign(new Error('Invalid login: 535 user:pass@smtp'), { code: 'EAUTH' })` → channel rejects with `email failed (EAUTH)` (no server text); without a `code` → `email failed`.
  - an already-aborted or later-aborted `signal` rejects with `timed out` even if `sendMail` never resolves (fake transport whose `sendMail` returns a never-settling promise).
  - `close()` calls `transport.close()`.
- [ ] **Step 3: Implement.** Default transport: `nodemailer.createTransport({ url: smtpUrl, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 5000, dnsTimeout: 5000 })` (no `logger`, no `debug`). Race `sendMail` against the abort signal with a small helper (add it to `http-post.ts` or a new `abortable.ts`; reuse it, do not duplicate). Body is plain text built from `plainText(note)`.
- [ ] **Step 4: Run** the spec, `npm run typecheck`, and `npm run build -w apps/api`. Expected: pass.
- [ ] **Step 5: Commit** `Add the email notification channel`.

---

### Task 4: Notifier core (claim loop, retries, triggers)

**Files:**
- Create: `apps/api/src/notify/notifier.ts`, `apps/api/src/notify/create-channels.ts`
- Test: `apps/api/src/notify/notifier.spec.ts`, `apps/api/src/notify/create-channels.spec.ts`

**Interfaces:**
- Consumes: `Channel`, `ClaimedAction`, `buildNote` (Task 2), `NotifyConfig` (Task 1), `AgentEvent` from `../events/agent-events`.
- Produces:
  ```ts
  export interface NotifyStore { claimUnnotified(limit: number): Promise<ClaimedAction[]> }
  export interface NotifierOptions {
    store: NotifyStore; channels: Channel[]; consoleUrl: string;
    log?: { warn(message: string): void };           // default: Nest Logger('Notifier')
    sleep?: (ms: number) => Promise<void>;           // default setTimeout based
    timeoutMs?: number;                              // 5000
    backoffMs?: number[];                            // [1000, 4000] => 3 attempts
    batch?: number;                                  // 20
    sweepMs?: number;                                // 60000
    debounceMs?: number;                             // 200
  }
  export class Notifier {
    constructor(opts: NotifierOptions);
    runOnce(): Promise<number>;                      // claim up to `batch`, deliver all, return how many were claimed
    request(): void;                                 // coalescing "please run a pass"
    start(bus: { subscribe(l: (e: AgentEvent) => void): () => void }): void;
    stop(): Promise<void>;
  }
  export const createChannels = (cfg: NotifyConfig): Channel[];
  ```

- [ ] **Step 1: Failing tests for delivery** (`notifier.spec.ts`; fake store whose `claimUnnotified` returns queued batches, fake channels as `{ name, send: jest.fn() }`, `sleep` recording its arguments, a captured `log`):
  - delivers each claimed row to every channel with a note equal to `buildNote(row, consoleUrl)`; returns the claimed count.
  - a channel that fails twice then succeeds: `send` called 3 times, sleeps `[1000, 4000]`, no log line.
  - a channel that always fails: 3 attempts, then exactly one log line `Notification via webhook failed for approval <id>: <message>`; the other channel still delivered; `runOnce` resolves (never rejects).
  - a channel error message that contains `https://hooks.example.com/SECRET`: the log line contains neither the URL nor `SECRET` (the notifier logs only `String(message).slice(0, 120)` after replacing `/https?:\/\/\S+/g` with `[url]` as a belt-and-braces guard).
  - a channel whose `send` never resolves but honours its `signal`: with `timeoutMs: 20` the attempt is aborted and counted as a failure (use real timers and tiny values; `sleep: async () => {}`).
  - claim failure (`claimUnnotified` rejects): logged as `Could not check for new approvals: <message>`, no throw.
  - `batch` handling: when a pass claims exactly `batch` rows the drain loop claims again until a pass returns fewer.
- [ ] **Step 2: Failing tests for triggers** (fake timers via `jest.useFakeTimers()`; fake bus capturing the listener):
  - `start(bus)` runs one pass immediately.
  - three `approvals` events within 200 ms cause exactly one more pass; a `trace` or `audit` event causes none; a `resync` causes one.
  - an event arriving while a pass is running sets a single follow-up pass (never two passes at once: track concurrent calls in the fake store).
  - the 60 s sweep triggers a pass; after `stop()` no timer fires and the bus listener is unsubscribed.
  - `stop()` waits for an in-flight pass, makes pending retries give up (no further `send` after stop), and calls `close()` on every channel that has one.
- [ ] **Step 3: Implement** `notifier.ts` as designed: `request()` starts `drain()` if idle else sets an `again` flag, and re-requests when the drain ends; `drain()` loops `runOnce()` while it returns `batch`; `deliver(channel, note)` does up to `1 + backoffMs.length` attempts, each with `AbortSignal.timeout(timeoutMs)`, sleeping `backoffMs[i]` between attempts and bailing out when `stopped`. Channels for one row run with `Promise.allSettled`; rows are delivered in order. Timers use `.unref()`.
- [ ] **Step 4: `createChannels`** builds `webhookChannel` / `slackChannel` / `emailChannel` from `cfg` in that order; test: empty config → `[]`; full config → names `['webhook','slack','email']` (stub nothing: constructing the email channel must not open a connection).
- [ ] **Step 5: Run** both specs + `npm run typecheck`. Expected: pass.
- [ ] **Step 6: Commit** `Add the Notifier: claim loop, retries and triggers`.

---

### Task 5: Storage claim, Nest wiring and end-to-end tests

**Files:**
- Modify: `apps/api/src/db/schema.ts` (column + index), `apps/api/src/db/pg-agent.store.ts` (`claimUnnotified`), `apps/api/src/agent/agent.module.ts` (provider)
- Create: `apps/api/src/notify/notifier.lifecycle.ts`, `apps/api/test/notifications.e2e-spec.ts`

**Interfaces:**
- Consumes: `Notifier`, `createChannels`, `notifyEnabled` (Tasks 1, 4), `ClaimedAction` (Task 2), `StreamBus`, `PgAgentStore`, `APP_CONFIG`.
- Produces: `PgAgentStore.claimUnnotified(limit: number): Promise<ClaimedAction[]>`; `NotifierLifecycle` Nest provider.

- [ ] **Step 1: Schema.** Append to `SCHEMA_SQL`, after the `actions` index:
  ```sql
  ALTER TABLE actions ADD COLUMN IF NOT EXISTS notified_at timestamptz;
  CREATE INDEX IF NOT EXISTS actions_unnotified_idx ON actions (created_at)
    WHERE status = 'pending_approval' AND notified_at IS NULL;
  ```
- [ ] **Step 2: `claimUnnotified`.** One statement:
  ```sql
  WITH picked AS (
    SELECT id FROM actions WHERE status = 'pending_approval' AND notified_at IS NULL
    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE actions a SET notified_at = now() FROM picked p WHERE a.id = p.id
    RETURNING a.id, a.tool_name, a.tool_args, a.created_at
  )
  SELECT c.id, c.tool_name, c.tool_args, c.created_at,
         (SELECT e.rule FROM approval_events e WHERE e.action_id = c.id AND e.kind = 'requested' ORDER BY e.id LIMIT 1) AS rule
  FROM claimed c ORDER BY c.created_at
  ```
  Map to `ClaimedAction` (`createdAt` as ISO string via `new Date(...).toISOString()`, `rule: row.rule ?? null`). It does not call `publish` (no stream event). Note in the report whether the new `notifiedAt` field now appears on action JSON returned by `GET /approvals` and `GET /conversations/:id`; it is accepted as harmless, but fix any test that compares whole action objects.
- [ ] **Step 3: `NotifierLifecycle`** (`@Injectable`, implements `OnModuleInit`, `OnApplicationShutdown`): constructor takes `@Inject(APP_CONFIG) cfg`, `PgAgentStore`, `StreamBus`; `onModuleInit` builds channels with `createChannels(cfg.notify)`, returns if `!notifyEnabled(cfg.notify)`, otherwise creates the `Notifier` (logger-based `log`, `consoleUrl: cfg.notify.consoleUrl`) and calls `start(bus)`; `onApplicationShutdown` awaits `stop()`. Register it in `AgentModule.providers`.
- [ ] **Step 4: e2e** (`notifications.e2e-spec.ts`, same `maybe` guard and boot pattern as `approval-flow.e2e-spec.ts`; it sets and restores `process.env` keys it uses; `afterEach` closes apps and the local receiver). A tiny `http.createServer` receiver on `127.0.0.1:0` records `{ headers, body }` and answers with a configurable status. Tests:
  1. **Store claim:** park two refunds via the store (`createConversation` / `createRun` / `createAction` as in `audit-log.e2e-spec.ts`); `claimUnnotified(1)` returns the older one, a second call returns the other, a third returns `[]`; an action that is decided (`decideAction`) before claim is never claimed; two concurrent `claimUnnotified(10)` calls over 5 pending rows return 5 distinct rows in total; `rule` comes from the `requested` event.
  2. **Webhook end to end:** env `NOTIFY_WEBHOOK_URL=http://127.0.0.1:<port>/hook`, `NOTIFY_WEBHOOK_SECRET=e2e-secret`, `REVIEWER_CONSOLE_URL=http://localhost:3000/reviewer`. Over HTTP start a conversation for customer 1 and send `Order #1 arrived damaged, please refund it` (parks). Wait (poll up to 3 s) for exactly one receiver hit; assert `event === 'approval.requested'`, `Object.keys(approval)` is a subset of `id, tool, orderId, amount, rule, createdAt, consoleUrl` and includes `tool: 'issue_refund'`, `orderId: 1`, `rule`; the raw body contains neither `Ava`, the customer's email, `damaged`, nor the conversation id; recompute the HMAC from `x-timestamp` and the raw body and compare with `x-signature`. Then wait 400 ms and assert still exactly one hit; approve the action (`POST /approvals/:id/approve` with the existing route/headers) and assert still one hit.
  3. **Two replicas, one notification:** seed, boot a second Nest app on the same database and env (so two `Notifier`s are listening), park a refund through the first app, and assert exactly one receiver hit after 800 ms.
  4. **Retries and logging against the real store:** with NO notify env, build a `Notifier` by hand using `app.get(PgAgentStore)`, a `webhookChannel` pointed at a receiver that answers 500, `sleep: async () => {}`, and a captured `log`; park a refund; `runOnce()` returns 1; the receiver saw 3 attempts; the log has exactly one `failed for approval` line that does not contain the receiver URL or secret; a second `runOnce()` returns 0 (at most once).
  5. **Disabled by default:** with no notify env, parking a refund leaves `notified_at IS NULL` (query the pool) and the receiver sees nothing.
- [ ] **Step 5: Run** `E2E_DATABASE_URL=… npm run test -w apps/api -- notifications` then the whole API suite (`npm test -w apps/api`) and root `npm run typecheck`. Existing suites must pass unchanged apart from any whole-action comparison forced by `notifiedAt`.
- [ ] **Step 6: Commit** (two commits are fine): `Claim pending approvals for notification atomically` and `Wire the notifier into the API with end-to-end tests`.

---

### Task 6: Docs and TODO

**Files:**
- Modify: `README.md`, `TODO.md`

- [ ] **Step 1: README.** Add a "Reviewer notifications" section (near the approvals / streaming docs): what triggers a notification, the seven variables in a table with defaults (`REVIEWER_CONSOLE_URL` default `http://localhost:3000/reviewer`), the webhook payload example and the signature recipe (`HMAC-SHA256` of `"<x-timestamp>.<raw body>"`, header `x-signature: sha256=<hex>`, receivers should also reject old timestamps), what is deliberately not sent, the retry policy, and the limits from the spec (at most once; 60 s worst-case delay; one notification per approval; pending only; webhook URLs must be https or localhost; works across replicas via the database claim). Add the new variables to the main configuration table. Do not claim a manual check against real Slack or SMTP servers: say the channels are covered by unit tests with fakes and the webhook by an end-to-end test.
- [ ] **Step 2: TODO.md.** Tick 4.4 (`- [x] 4.4 …`), keep wording otherwise.
- [ ] **Step 3: Run** `npm run typecheck`, `npm test`. Fix any README claim that the code does not support.
- [ ] **Step 4: Commit** `Document reviewer notifications; tick TODO 4.4`.
