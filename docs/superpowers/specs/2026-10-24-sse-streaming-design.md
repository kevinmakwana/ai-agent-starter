# Live updates over SSE (TODO 4.1)

## Goal

The customer chat and the reviewer console find out about changes by polling (chat: every 500 ms while
sending, 3 s otherwise; console: every 2 s). Replace the polling with server-sent events so a new step, a
run status change, a parked approval or an audit row shows up the moment it is committed. Polling stays only
as a fallback when the stream is down.

Success criteria:

- A step, run status change, approval or audit row appears in the open UI without waiting for a poll.
- A stream can never reveal anything the REST API would hide from that caller.
- No credential appears in a URL, a log or browser history.
- If the stream cannot connect or drops, the UI keeps working by polling, and recovers by itself.
- An event can never announce a write that rolled back.

## Decisions made

| Question | Decision |
|---|---|
| What is streamed | Run, step, approval and audit change signals. Not token-by-token model text. |
| Event content | Signal only (`kind` + `conversationId`). The client refetches through the existing GET endpoints, so customer/reviewer filtering stays in one place. |
| Authentication | A `fetch`-based SSE client sending the same headers as every other call (`x-conversation-token`, `Authorization: Bearer`). Native `EventSource` and ticket / query-string credentials are not used. |
| Event bus | Postgres `LISTEN`/`NOTIFY`, so it also works with more than one API replica. |
| Reconnect | No replay buffer; event ids are per-connection and unused. Every (re)connect triggers a refetch. |

## 1. Event source and bus

- The store publishes with `pg_notify('agent_events', payload)` inside its own write transactions. Postgres delivers
  a NOTIFY only when the transaction commits, so an event cannot precede its data or announce a rolled-back write,
  and the runner has nothing to remember. Payload: `{ "kind": "...", "conversationId": "..." }`, far below the
  8 KB limit.
- Kinds:
  - `trace`: a run, step or action changed (`createRun`, `updateRun`, `addStep`, `createAction`, `decideAction`,
    `reopenAction`, `setActionResult`).
  - `approvals`: an approval was created or decided (`createAction`, `decideAction`, `reopenAction`).
  - `audit`: a row was inserted into `approval_events`.
- `StreamBus` (new, injectable) owns one dedicated `LISTEN agent_events` connection, separate from the pool because
  pooled connections can be recycled. It fans events out to in-process subscribers.
- If the LISTEN connection errors or ends, `StreamBus` reconnects with backoff, re-issues `LISTEN`, and then emits a
  synthetic `resync` event to every subscriber, because events may have been missed meanwhile. It stops cleanly on
  module shutdown.
- The in-memory fake store does not publish. The runner does not depend on publishing; stream behaviour is covered by
  e2e tests on the real test database.

## 2. API

- `GET /conversations/:id/events` behind `ConversationAccessGuard` (customer token or reviewer key). Streams that
  conversation's `trace` events and `resync` only. Customers never receive `approvals` or `audit` kinds.
- `GET /events` behind `ReviewerGuard`. Streams `trace`, `approvals` and `audit` for every conversation, plus `resync`.
- Wire format: `text/event-stream`; `event: <kind>` with `data: {"conversationId":"..."}` (`resync` carries `{}`);
  a `: ping` comment every 15 s; `Cache-Control: no-cache, no-transform`; `X-Accel-Buffering: no`. No replay: Nest adds an incrementing per-connection `id:` to typed events, which the client ignores (see Notes from the installed NestJS).
- Limits: a configurable cap on concurrent streams, per conversation and for `/events`, returning `429` over the cap.
  A closed or errored client releases its slot and its subscription.
- The guards run before the stream opens, so a wrong or missing credential is an ordinary `401` / `404` response.
- The Next.js proxy route passes the response body through; it adds `dynamic = 'force-dynamic'`, `no-cache`
  headers on streaming responses and forwards `req.signal` upstream, so closing the browser closes the upstream
  stream.

## 3. Web client

- `lib/stream.ts`: `openStream(path, headers, handlers)` reads `text/event-stream` with `fetch` and `ReadableStream`,
  parses `event:` / `data:` lines (chunks split anywhere, CRLF, multi-line `data:`, `: comments` ignored), reconnects with
  exponential backoff plus jitter (1 s to 15 s) and aborts on unmount. A 401 or 404 stops retrying and reports an error.
- `useEventStream` hook reports `live`, `connecting` or `down`.
- Both pages drop their `setInterval`. An event triggers a debounced (about 100 ms) refresh; every successful
  (re)connect triggers one refresh. On the reviewer page a `trace` event refreshes the selected conversation only if it
  matches; `approvals` refreshes the approvals list; `audit` refreshes the audit tab; `resync` refreshes everything.
- While the stream is `down`, the old polling resumes (chat 3 s, console 2 s). A small live/reconnecting indicator in
  the top bar shows the mode.
- `POST /messages` still blocks until the run finishes, so its contract is unchanged. Steps appear live through the
  stream; the POST result is one more refresh trigger.

## 4. Testing

- Unit: SSE parser (split chunks, CRLF, multi-line data, comments); backoff and stop-on-401; `StreamBus` fan-out,
  `resync` after reconnect, unsubscribe cleanup.
- E2E (real test DB on port 5435): a customer stream receives `trace` when a message is sent; a stream for
  conversation A never receives B's events; wrong or missing token gives 401 and a wrong key on `/events` gives 401;
  the reviewer stream receives `approvals` and `audit` when a refund is parked and decided; a rolled-back write
  publishes nothing; terminating the LISTEN backend produces `resync` after reconnect; a closed client frees its slot;
  the cap returns 429.
- Existing suites pass unchanged.

## 5. Docs and limitations

- README: a streaming section and endpoint rows; TODO 4.1 ticked; the audit-log wording about refreshing like the
  approvals list is updated.
- Documented limitations: events are hints with no replay, so a consumer that was down refetches; the stream cap is
  per process; text is not streamed token by token (the model's reply appears whole when its step is saved); the manual
  browser check is not automated.
- At planning time, verify the NestJS version's `@Sse()` / `Observable` behaviour, `pg` `Client` notification API and
  the Next.js route-handler streaming behaviour against current documentation.

## Notes from the installed NestJS

- Nest defers the response headers until the first message, so the server writes a `: connected` comment immediately; without it a client would not see the response open until the first real event or ping.
- Nest adds an incrementing `id:` to every typed event, per connection. The client ignores it, so "no `id:` field" became "no replay: ids are per-connection and unused".
- `@Sse` supports `comment` messages, which carry the `: ping` heartbeat (and `: connected`).
- Shutdown: `StreamBus.beforeApplicationShutdown` completes all open streams so `SIGTERM` / `docker stop` does not hang on them. Graceful shutdown can still wait up to the idle keep-alive timeout (about 4-5 s) for a pooled idle client socket.
- Web client states: `connecting` once at the start, then `live` or `down`; the top-bar chip reads Live / Connecting / Polling. Stream caps are `STREAM_MAX_PER_CONVERSATION` (5) and `STREAM_MAX_REVIEWER` (20).

## Out of scope

Token-by-token text streaming, notification channels (4.4), reviewer accounts (4.5), event replay or `Last-Event-ID`,
WebSockets.
