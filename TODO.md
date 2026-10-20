# TODO

## Phase 1: Correctness
- [x] 1.1 Fix the stranded approval in `runner.decide()`: execution failures must not leave the action `approved` with no result; the reviewer can retry.
- [x] 1.2 Per-conversation lock so concurrent `POST /messages` (or a message racing an approval) can't interleave steps.
- [x] 1.3 `UNIQUE` on `refunds.action_id` (partial, where not null) as a DB-level backstop against double refunds.
- [x] 1.4 Scope the trace query: `listApprovals({ conversationId })` instead of fetching 200 global rows and filtering in JS.
- [x] 1.5 Drop `customerId` from the `list_orders` and `create_ticket` schemas; use the bound customer.
- [x] 1.6 Show customers a generic message instead of `run.error`; keep the detail in the reviewer trace only.

## Phase 2: Safety and cost
- [x] 2.1 helmet, CORS config and rate limiting (stricter on `POST /conversations` and `POST /messages`).
- [x] 2.2 Aggregate tokens per run/conversation and add a configurable token budget.
- [x] 2.3 Cap the context sent to the model (sliding window or summary); load steps once per run.
- [x] 2.4 Expire pending approvals (configurable TTL, auto-reject with a note).

## Phase 3: Real-provider confidence
- [x] 3.1 Retries with backoff and jitter for 429/5xx and network errors (honour `Retry-After`).
- [x] 3.2 Handle `max_tokens` / `length` stop reasons so a truncated tool call is never executed.
- [x] 3.3 Configurable `max_tokens`; Anthropic prompt caching for system prompt and tools.
- [x] 3.4 Record provider, model and prompt version per run and show them in the trace UI.
- [x] 3.5 Scheduled/manual CI job for `smoke:llm` with repo secrets.
- [ ] 3.6 Verify against a live key that the Anthropic adapter's history is accepted when thinking is on (Sonnet 5.5 thinks by default): it drops `thinking` blocks when replaying a tool-call turn. If the API rejects that, preserve the blocks within the current turn only (older turns are trimmed by the context cap, which would break their signatures).

## Audit of Phases 1-3 (edge cases found after the phases shipped)
- [x] A.1 Failing to save the first user message no longer leaves the run `running` (it blocked the conversation for 10 minutes).
- [x] A.2 `decide()` failures after the claim: reopen if the result was not saved, fail the run if the trace could not be, answer with `UNKNOWN_TOOL` for a retired tool.
- [x] A.3 Crash recovery: finish decisions claimed by a process that died (idempotent refund, runs only while the run still waits).
- [x] A.4 Order ids bounded to the integer range; NUL rejected in messages, titles, notes and model-supplied tool arguments; whitespace-only messages rejected and messages trimmed.
- [x] A.5 Non-UUID conversation id with a token header is `401`, not a database error.
- [x] A.6 `AGENT_MAX_STEPS`, `API_PORT`, `MOCK_DELAY_MS` validated (NaN used to skip the agent loop silently).
- [x] A.7 Providers: non-JSON / truncated bodies and unreadable error bodies become `UpstreamLlmError`; `model_context_window_exceeded` guarded; malformed OpenAI tool calls survive.
- [x] A.8 Empty model replies are never stored as blank messages (Anthropic rejects them on the next call); their tokens still count toward the budget; blank steps are hidden in the customer chat.
- [x] A.9 Approval sweep never overlaps itself; TTL wording is readable for short TTLs.

## Phase 4: Features
- [ ] 4.1 SSE streaming of runs (API + `EventSource` in the web app).
- [ ] 4.2 Threshold-based approval policy per tool.
- [ ] 4.3 Audit log of approval decisions, shown in the reviewer console.
- [ ] 4.4 Reviewer notifications on new pending approvals (webhook, then email/Slack).
- [ ] 4.5 Per-reviewer accounts, four-eyes rule, then customer login.
- [ ] 4.6 More tools: `cancel_order` (risky), `track_shipment`.

## Phase 5: Tooling and operations
- [ ] 5.1 ESLint, Prettier, `.editorconfig` and a lint step in CI.
- [ ] 5.2 Web tests (Vitest + RTL, one Playwright e2e flow) in CI.
- [ ] 5.3 Coverage reporting in CI.
- [ ] 5.4 Dockerfiles for API and web; full-stack compose.
- [ ] 5.5 Real migrations instead of DDL on boot.
- [ ] 5.6 Structured logging with request IDs; liveness/readiness split for `/health`.
- [ ] 5.7 Remove `any` in tools, provider parsing and web types.
- [ ] 5.8 Eval suite (recorded traces, prompt-injection cases).
