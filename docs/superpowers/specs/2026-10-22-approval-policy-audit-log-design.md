# Approval policy and audit log (TODO 4.2 + 4.3)

## Goal

Every `issue_refund` currently waits for a human, however small. Let low-value refunds run without a
reviewer while keeping humans on the larger ones, and record every approval decision (human, automatic
or expired) in an append-only audit log that the reviewer console shows.

Success criteria:

- Policy is decided per tool by code and config. The model influences it only through the amount it asks for.
- A refund under the threshold runs inline with every existing guardrail (ownership, over-refund, idempotency) still applied.
- Default behaviour is unchanged: with the threshold unset, every refund is parked for review.
- Every decision is logged, auto-approvals included, with the rule that allowed it.
- The reviewer console shows the log and, on pending cards, why a human is needed.

## Decisions made

| Question | Decision |
|---|---|
| What a threshold decides | Auto-approve below it, human at or above it. No third tier and no auto-reject ceiling. |
| Splitting protection | Cumulative per order: `priorRefunded + amount` must be strictly under the threshold. |
| Audit scope | Decisions and why: `requested`, `auto_approved`, `approved`, `rejected`, `expired`. No execution-lifecycle events. |
| Structure | Pure policy module plus an `approval_events` table (approach A). |
| Reviewer identity | `actor_id` is nullable and stays null until 4.5 (reviewer accounts). |

## 1. Policy and config

- New setting `REFUND_AUTO_APPROVE_UNDER`: a non-negative amount in dollars with at most 2 decimals, validated in
  `config.ts` like the other values and exposed as `AppConfig.approvalPolicy.refundAutoApproveUnder`.
  Unset or `0` means always ask a human. Documented in `.env.example` and the README.
- New `agent/policy.ts` exports a pure `evaluateApproval(toolName, args, facts, config)` that returns
  `{ mode: 'auto' | 'human', rule, detail }`.
  - `issue_refund`: `auto` only if `priorRefunded + amount` is strictly under the threshold, compared in cents.
  - Rules: `always_review` (no threshold), `under_threshold`, `over_threshold`.
  - Anything else fails closed to `human` with rule `default`: an unknown risky tool, missing facts, a non-finite number.
- `ToolDef.preflight` returns its facts instead of `void` (`{ priorRefunded }` for refunds). It already loads
  the order and the refunded total, so there is no extra query.
- Known limitation: two conversations of the same customer could each auto-approve a small refund on one order at
  the same moment, because the cumulative check is not atomic. The over-refund guard inside `createRefund`
  still caps the total at the order total. Documented, not locked.

## 2. Runner flow

`AgentRunner.execute()` order: unknown tool, then argument validation, then `preflight` (existing guardrails),
then `evaluateApproval`.

- **auto**: write the `auto_approved` event first, then run `tool.execute` inline and return its result as a normal
  tool result; the run continues and does not park. If the event cannot be written, the tool does not run.
  No `actions` row exists for an auto-approved call, so `refunds.action_id` is null for these refunds.
- **human**: park exactly as today. The `requested` event is written with the action row.
- **human decisions**: `decideAction` writes the `approved` or `rejected` event in the same transaction as the
  claim, so a decision cannot exist without its log row. `runner.decide` takes an actor (`reviewer` or `system`);
  the TTL sweep passes `system` and its rejections log as `expired`.
- If execution fails after a claim and the reviewer retries, the log shows two decision rows for the one action.
  That is accurate, so history is not rewritten.

## 3. Audit data model

New append-only table `approval_events`, added as idempotent DDL in `schema.ts` and to `RESET_SQL`.

| column | notes |
|---|---|
| `id` | bigserial |
| `kind` | `requested`, `auto_approved`, `approved`, `rejected`, `expired` (CHECK) |
| `action_id` | uuid, nullable (auto-approved calls have no action row) |
| `run_id`, `conversation_id` | foreign keys, `ON DELETE CASCADE` like the other tables |
| `actor_type` | `reviewer`, `system`, `policy` (CHECK) |
| `actor_id` | text, nullable (filled by 4.5) |
| `tool_name`, `tool_args` | snapshot of the call at that moment |
| `rule` | text, nullable; set for policy-driven events |
| `detail` | jsonb, e.g. `{ threshold, priorRefunded, amount }` |
| `note` | text, nullable; the reviewer's note |
| `created_at` | timestamptz |

No UPDATE or DELETE code paths exist; rows disappear only through the conversation cascade. `AgentStore` gains
`addApprovalEvent` and `listApprovalEvents`. `PgAgentStore.decideAction` and the in-memory fake in
`test/fakes.ts` both write the event so tests exercise the same behaviour.

## 4. API and UI

- `GET /approvals/events?conversationId=&limit=&before=` behind `ReviewerGuard`. Newest first, default limit 100,
  maximum 200, `before=<id>` as the only paging. Declared before `:id` so it is not captured by that route.
- Reviewer console: a second tab, "Audit log", beside pending approvals. Each row shows time, a kind chip
  (auto-approved visually distinct), tool and amount, who decided (Reviewer / System / Policy), the rule and any
  note. It refreshes the way the approvals list does today (SSE arrives with 4.1).
- Pending approval cards show why a human is needed (e.g. "Over the $25 auto-approve limit"), taken from the
  `requested` event's `rule` and `detail`.
- Customer chat is unchanged: customers never see the log or the policy.

## 5. Testing

- `policy.spec.ts` (pure): exactly equal to the threshold goes to a human, one cent under is auto, cumulative
  prior refunds push a call over, unset / `0` / invalid config, unknown tool fails closed.
- `runner.spec.ts`: an auto refund executes inline with no action row and no pause; `auto_approved` is written
  before the refund runs; an audit write failure blocks the refund; an over-threshold call still parks and logs
  `requested`; over-refund and wrong-customer guardrails still apply to auto candidates.
- Store and e2e: a decision and its event commit together; expiry logs `expired` with actor `system`; the events
  endpoint requires the reviewer key and honours `limit` and `before`; the existing approval-flow e2e passes with
  the threshold unset.
- `config.spec.ts`: validation of the new setting.
- Docs: README, `.env.example`, and TODO (4.2 and 4.3 ticked).

## Out of scope

Policies for other tools (4.6), reviewer identity (4.5), live-updating log (4.1), audit export or retention,
execution-lifecycle events.
