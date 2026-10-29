# Reviewer notifications on new pending approvals (TODO 4.4)

## Goal

A reviewer should not have to keep the console open to learn that something is waiting. When the agent parks a risky
action for human approval, the API pushes one short notification to a generic webhook, to Slack and to email, whichever
the operator has configured.

Success criteria:

- Each newly parked approval produces exactly one notification per configured channel, even with several API replicas
  or after a restart.
- A notification never contains customer personal data or customer-written text.
- A slow, failing or misconfigured channel never blocks the agent run, an approval decision or another channel.
- With no channel configured the feature does nothing and the API behaves exactly as before.
- Secrets (webhook URLs, SMTP credentials, the signing secret) never appear in logs or notifications.

## Decisions made

| Question | Decision |
|---|---|
| Channels | Generic signed webhook, Slack incoming webhook, email over SMTP. Each is on only when its variables are set. |
| Failed delivery | Three attempts with backoff, then a warning in the log. In-process; not durable across a restart. |
| Content | Summary only: no customer name, email, message or free-text reason. |
| Duplicates | A `notified_at` claim in Postgres, so replicas and restarts never send an approval twice. |
| What triggers it | The 4.1 event bus (`approvals` and `resync`), plus a startup sweep and a 60 s safety-net sweep. |

## 1. Trigger and claim

- `actions.notified_at timestamptz` (added with `ALTER TABLE … ADD COLUMN IF NOT EXISTS`) and a partial index on
  `created_at` where `status = 'pending_approval' AND notified_at IS NULL`. No backfill is needed: only pending actions are
  ever claimed, so old decided rows are never announced. Pending ones at upgrade time are announced once, which is the
  desired behaviour.
- `PgAgentStore.claimUnnotified(limit)`: one statement,
  `UPDATE actions SET notified_at = now() WHERE id IN (SELECT id FROM actions WHERE status = 'pending_approval' AND
  notified_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) RETURNING …`. Atomic and safe across
  replicas: each pending action is claimed by exactly one process. It returns only the fields a notification needs
  (see section 3), joined to the order total for refunds.
- `Notifier` (injectable, `apps/api/src/notify/`) runs `claimUnnotified` and dispatches each result:
  - on an `approvals` bus event (the bus carries `approvals` for create and for decide; a decide claims nothing),
  - on `resync`,
  - once at startup,
  - every 60 s (`unref`'d interval) as a safety net.
  Runs never overlap (a pass that is still delivering makes the next trigger set a "run again" flag instead of starting a
  second pass). Bus events are debounced about 200 ms so a burst becomes one claim.
- Delivery is **at most once**: the claim commits before delivery. If the process dies mid-delivery, or all attempts
  fail, that approval is not announced again. It is still in the console and in the log. This is a documented limit,
  chosen over a durable outbox.
- `Notifier` stops its timers on shutdown and waits for an in-flight pass to finish (bounded by the delivery timeouts).

## 2. Channels

A channel is `{ name, send(note): Promise<void> }`. The `Notifier` calls every configured channel concurrently
(`Promise.allSettled`) and gives each its own retry loop.

- **Retry**: 3 attempts, waits of 1 s then 4 s between them, a 5 s timeout per attempt (`AbortSignal.timeout`). Any
  thrown error or non-2xx status is a failed attempt. A failure after the last attempt logs
  `Notification via <channel> failed for approval <id>: <short reason>` and nothing else (no URL, no body, no secrets).
- **Webhook** (`NOTIFY_WEBHOOK_URL`, optional `NOTIFY_WEBHOOK_SECRET`): `POST` with `Content-Type: application/json`
  and body `{ "event": "approval.requested", "approval": { … } }` (section 3). With a secret set, header
  `X-Signature: sha256=<hex HMAC-SHA256 of the raw body>` and `X-Timestamp: <unix seconds>`; the timestamp is part of
  the signed string (`<timestamp>.<body>`) so a receiver can reject replays. Redirects are not followed.
- **Slack** (`NOTIFY_SLACK_WEBHOOK_URL`): `POST {"text": "…"}` to a Slack incoming webhook; one line such as
  `Approval needed: refund $18.75 on order #11 (rule: always_review) – <console link|Open the reviewer console>`.
  All interpolated values are ids, numbers or values from a fixed list, and Slack control characters (`& < >`) are
  escaped anyway.
- **Email** (`NOTIFY_SMTP_URL`, `NOTIFY_EMAIL_FROM`, `NOTIFY_EMAIL_TO`, comma-separated): `nodemailer`, one message to
  all recipients, a plain-text body (no HTML) with the same facts and the console link. The transport is created once
  at startup with `connectionTimeout`, `greetingTimeout` and `socketTimeout` set to 5 s and is closed on shutdown. The
  SMTP URL (which carries credentials) is never logged; the library's `logger` and `debug` stay off.
- **Config validation** (in `loadConfig`, failing fast at startup like the other variables): webhook URLs must parse and
  be `https:`, or `http:` for `localhost`/`127.0.0.1`/`::1` only (so a typo or `file:` URL cannot make the API probe
  internal services; this is not a full SSRF defence, the operator controls these values); `NOTIFY_SMTP_URL` must be
  `smtp:` or `smtps:`; email needs all three of URL, from and to or none; a secret without a webhook URL is an error.
- `REVIEWER_CONSOLE_URL` (default `http://localhost:3000/reviewer`) is the link put in messages.

## 3. Content

The `note` handed to every channel:

```
{ id, tool, orderId, amount?, rule?, createdAt, consoleUrl }
```

- `tool`: `issue_refund` | `cancel_order` | `create_ticket` | other registered risky tool name (from the tool registry).
- `orderId`: from `tool_args.orderId` when it is an integer, else omitted.
- `amount`: from `tool_args.amount` for `issue_refund`, as a number with two decimals; omitted otherwise.
- `rule`: the `rule` of the action's `requested` audit event (`always_review`, `over_threshold`, `tool_requires_review`, …).
- Never included: customer id, name, email, conversation id or messages, `reason`, `reasoning`, `tool_args` as a whole,
  tracking or any order contents. A cancellation's free-text reason is customer-supplied and is deliberately left out; the
  reviewer reads it in the console.
- The note is built by one pure function from the claimed row, so a test can assert the exact allowed keys.

## 4. Wiring

- `NotifyModule` pieces live in `AgentModule` providers next to `StreamBus`: a `Notifier` factory reading `cfg.notify`,
  a `NotifierScheduler` (OnModuleInit/OnApplicationShutdown, like `ApprovalExpiryScheduler`).
- `AppConfig.notify = { webhook?: { url, secret? }, slack?: { url }, email?: { smtpUrl, from, to[] }, consoleUrl }`.
  When none of the three is set the scheduler does not start and no claim runs, so `notified_at` stays null for new rows
  (enabling a channel later announces what is pending then, which is the useful behaviour).
- The web app needs no change.

## 5. Testing

- Unit: URL validation and config errors; the `note` builder allowlist (including a hostile `tool_args` and a reason
  containing an email address); webhook signature (known vector) and headers; Slack escaping; email message fields
  against nodemailer's `jsonTransport`; retry schedule, timeout and "logs without secrets" with fake timers and a fake
  channel; non-overlap; one failing channel does not stop the others; disabled-by-default.
- E2E (port 5435 `aiagent_test` only): `claimUnnotified` returns an action once and a concurrent second claim gets
  nothing; decided and old actions are not claimed; over HTTP with a local receiver, parking a refund delivers exactly one
  webhook with the allowed keys and a valid signature, a second `Notifier` instance on the same database delivers none, and
  approving it delivers nothing further; a receiver that returns 500 is retried and then logged without the URL.
- Existing suites pass unchanged.

## 6. Docs and limitations

- README: a Notifications section with the variable table, the payload and signature, and the limits below; `.env.example`
  entries; TODO 4.4 ticked.
- Limits: at-most-once delivery (a crash or three failures loses that notification; the console remains the source of
  truth); the 60 s sweep is the worst-case delay if the bus signal is missed; one notification per approval, no reminders,
  no per-reviewer routing; notifications fire for pending approvals only, not for decisions or expiry.

## Out of scope

Notifying on decisions or expiry, reminders and escalation, per-reviewer routing and preferences (4.5), a durable outbox
with a retry worker, HTML email, digests.
