# Approval Policy and Audit Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let refunds under a configurable cumulative per-order threshold run without a reviewer, and record every approval decision in an append-only audit log that the reviewer console shows.

**Architecture:** A pure `evaluateApproval()` in `agent/policy.ts` decides `auto` or `human` for a risky tool call from the call's arguments, facts gathered by `preflight`, and config. The runner consults it in the one place it currently checks `tool.risky`. A new `approval_events` table is written by the store in the same transaction as the action row (`requested`) or the claim (`approved` / `rejected` / `expired`), and by the runner before an inline execution (`auto_approved`). A reviewer-only `GET /approvals/events` and an "Audit log" tab expose it.

**Tech Stack:** NestJS 11, Postgres (`pg`), Jest + ts-jest, class-validator, Next.js (React client components) in `apps/web`.

**Spec:** `docs/superpowers/specs/2026-10-22-approval-policy-audit-log-design.md`

## Global Constraints

- Default behaviour is unchanged: `REFUND_AUTO_APPROVE_UNDER` unset or `0` means every refund is parked for review.
- Auto-approve only if `priorRefunded + amount` is **strictly under** the threshold, compared in **cents**.
- Anything the policy cannot evaluate (unknown risky tool, missing facts, non-finite number) fails closed to `human` with rule `default`.
- If the `auto_approved` event cannot be written, the tool must not run.
- A human decision and its event commit in one transaction; so does a new action and its `requested` event.
- `approval_events` has no UPDATE or DELETE code path. Rows disappear only through the `ON DELETE CASCADE` of their conversation.
- `actor_id` is nullable and stays null (4.5 fills it). Customer-facing responses never include events or policy details.
- Event kinds: `requested`, `auto_approved`, `approved`, `rejected`, `expired`. Actor types: `reviewer`, `system`, `policy`.
- `GET /approvals/events`: reviewer-guarded, newest first, default limit 100, max 200, `before=<id>` as the only paging.
- Existing callers of `store.decideAction(id, status, note?)` and `store.createAction({...})` (tests included) must keep compiling, so the new parameters are optional.
- Follow the surrounding code's style: terse comments only where the why is non-obvious, no new dependencies.
- `apps/web/AGENTS.md` says this Next.js has breaking changes. The web task only uses patterns already present in `apps/web/src` (client components, `useState`, plain CSS); do not introduce new Next.js APIs.

## Review Focus

- Threshold boundary: a refund of exactly the threshold goes to a human; one cent under auto-approves (Task 1, Task 3).
- Float drift: `0.1 + 0.2`-style amounts must not flip the comparison (Task 1 compares in cents).
- Splitting: prior refunds on the order count toward the threshold (Task 1, Task 3, Task 4).
- Audit failure must block the refund, never the other way round (Task 3).
- Auto-approved candidates still go through ownership and over-refund guardrails and write no event when blocked (Task 3).
- A double decision (two reviewers clicking at once) writes exactly one decision event (Task 2).
- Expiry logs `expired` / `system`, not `rejected` / `reviewer` (Task 3).
- Bad query input to `/approvals/events` (limit 0, 201, non-numeric, bad UUID) is a 400, not a database error (Task 4).
- Customers cannot read the audit log, even with a conversation token (Task 4).

---

### Task 1: Policy module and config

**Files:**
- Create: `apps/api/src/agent/policy.ts`
- Create: `apps/api/src/agent/policy.spec.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/config.spec.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces (used by Tasks 3 and 4):
  ```ts
  export interface ApprovalPolicyConfig { refundAutoApproveUnder: number } // dollars; 0 = always review
  export interface ApprovalFacts { priorRefunded?: number }
  export type ApprovalRule = 'always_review' | 'under_threshold' | 'over_threshold' | 'default';
  export interface ApprovalDecision { mode: 'auto' | 'human'; rule: ApprovalRule; detail: Record<string, unknown> }
  export function evaluateApproval(toolName: string, args: unknown, facts: ApprovalFacts, config: ApprovalPolicyConfig): ApprovalDecision
  ```
  and `AppConfig.approvalPolicy: ApprovalPolicyConfig`.

- [ ] **Step 1: Write the failing policy tests**

Create `apps/api/src/agent/policy.spec.ts`:

```ts
import { evaluateApproval, type ApprovalPolicyConfig } from './policy';

const cfg = (refundAutoApproveUnder: number): ApprovalPolicyConfig => ({ refundAutoApproveUnder });
const refund = (amount: unknown, priorRefunded: number | undefined, threshold: number) =>
  evaluateApproval('issue_refund', { orderId: 1, amount, reason: 'x' }, { priorRefunded }, cfg(threshold));

describe('evaluateApproval for issue_refund', () => {
  it('auto-approves strictly under the threshold and records the numbers it used', () => {
    expect(refund(24.99, 0, 25)).toEqual({
      mode: 'auto', rule: 'under_threshold', detail: { threshold: 25, priorRefunded: 0, amount: 24.99 },
    });
  });

  it('sends a refund of exactly the threshold to a human', () => {
    expect(refund(25, 0, 25)).toMatchObject({ mode: 'human', rule: 'over_threshold' });
  });

  it('counts earlier refunds on the order toward the threshold (no splitting)', () => {
    expect(refund(10, 15, 25)).toMatchObject({ mode: 'human', rule: 'over_threshold' }); // 25.00 is not under 25
    expect(refund(10, 14.99, 25)).toMatchObject({ mode: 'auto', rule: 'under_threshold' }); // 24.99 is
  });

  it('compares in cents, so floating point drift cannot flip the result', () => {
    expect(refund(0.3, 0.1, 0.41)).toMatchObject({ mode: 'auto' }); // 0.1 + 0.3 is 0.4 in cents, not 0.40000000000000002
    expect(refund(0.2, 0.1, 0.3)).toMatchObject({ mode: 'human' }); // 0.1 + 0.2 must equal 0.3, not sit just under it
  });

  it('always reviews when no threshold is set', () => {
    expect(refund(0.01, 0, 0)).toMatchObject({ mode: 'human', rule: 'always_review' });
    expect(refund(0.01, 0, -5)).toMatchObject({ mode: 'human', rule: 'always_review' });
    expect(refund(0.01, 0, Number.NaN)).toMatchObject({ mode: 'human', rule: 'always_review' });
  });

  it('fails closed when it cannot evaluate', () => {
    expect(refund(10, undefined, 25)).toMatchObject({ mode: 'human', rule: 'default' }); // no facts
    expect(refund('10', 0, 25)).toMatchObject({ mode: 'human', rule: 'default' });
    expect(refund(Number.NaN, 0, 25)).toMatchObject({ mode: 'human', rule: 'default' });
    expect(refund(-1, 0, 25)).toMatchObject({ mode: 'human', rule: 'default' });
    expect(refund(0, 0, 25)).toMatchObject({ mode: 'human', rule: 'default' });
    expect(evaluateApproval('issue_refund', null, { priorRefunded: 0 }, cfg(25))).toMatchObject({ mode: 'human', rule: 'default' });
  });
});

describe('evaluateApproval for other tools', () => {
  it('sends an unknown risky tool to a human', () => {
    expect(evaluateApproval('cancel_order', { orderId: 1 }, {}, cfg(1000))).toEqual({ mode: 'human', rule: 'default', detail: {} });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w apps/api -- policy.spec`
Expected: FAIL, "Cannot find module './policy'".

- [ ] **Step 3: Implement the policy module**

Create `apps/api/src/agent/policy.ts`:

```ts
export interface ApprovalPolicyConfig {
  /** Refunds whose order total (this one plus earlier refunds) stays under this many dollars skip review. 0 = always review. */
  refundAutoApproveUnder: number;
}

/** What `preflight` learned about the world, for the policy to weigh. */
export interface ApprovalFacts {
  priorRefunded?: number;
}

export type ApprovalRule = 'always_review' | 'under_threshold' | 'over_threshold' | 'default';

export interface ApprovalDecision {
  mode: 'auto' | 'human';
  rule: ApprovalRule;
  /** The numbers the decision used; stored in the audit log. */
  detail: Record<string, unknown>;
}

const toCents = (n: number) => Math.round(n * 100);
const isMoney = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

const human = (rule: ApprovalRule, detail: Record<string, unknown> = {}): ApprovalDecision => ({ mode: 'human', rule, detail });

function evaluateRefund(args: unknown, facts: ApprovalFacts, config: ApprovalPolicyConfig): ApprovalDecision {
  const threshold = config.refundAutoApproveUnder;
  if (!(threshold > 0)) return human('always_review');

  const amount = (args as { amount?: unknown } | null)?.amount;
  const { priorRefunded } = facts;
  if (!isMoney(amount) || amount === 0 || !isMoney(priorRefunded)) return human('default');

  const detail = { threshold, priorRefunded, amount };
  return toCents(priorRefunded) + toCents(amount) < toCents(threshold)
    ? { mode: 'auto', rule: 'under_threshold', detail }
    : human('over_threshold', detail);
}

/**
 * Decides whether a risky tool call needs a human. Pure, so the rules can be tested without a database.
 * Anything it does not recognise or cannot evaluate goes to a human.
 */
export function evaluateApproval(toolName: string, args: unknown, facts: ApprovalFacts, config: ApprovalPolicyConfig): ApprovalDecision {
  if (toolName === 'issue_refund') return evaluateRefund(args, facts, config);
  return human('default');
}
```

- [ ] **Step 4: Run the policy tests to verify they pass**

Run: `npm test -w apps/api -- policy.spec`
Expected: PASS (all tests in `policy.spec.ts`).

- [ ] **Step 5: Write the failing config tests**

Append to `apps/api/src/config.spec.ts`:

```ts
describe('approval policy config', () => {
  it('always reviews by default, accepts dollars and cents, and rejects junk', () => {
    expect(loadConfig({}).approvalPolicy).toEqual({ refundAutoApproveUnder: 0 });
    expect(loadConfig({ REFUND_AUTO_APPROVE_UNDER: '' }).approvalPolicy.refundAutoApproveUnder).toBe(0);
    expect(loadConfig({ REFUND_AUTO_APPROVE_UNDER: '25' }).approvalPolicy.refundAutoApproveUnder).toBe(25);
    expect(loadConfig({ REFUND_AUTO_APPROVE_UNDER: '24.99' }).approvalPolicy.refundAutoApproveUnder).toBe(24.99);
    for (const bad of ['-1', 'lots', '10.005', 'Infinity', 'NaN']) {
      expect(() => loadConfig({ REFUND_AUTO_APPROVE_UNDER: bad })).toThrow('REFUND_AUTO_APPROVE_UNDER');
    }
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -w apps/api -- config.spec`
Expected: FAIL (`approvalPolicy` is undefined).

- [ ] **Step 7: Implement the config**

In `apps/api/src/config.ts`, add the import at the top:

```ts
import type { ApprovalPolicyConfig } from './agent/policy';
```

Add after `nonNegativeInt`:

```ts
/** A dollar amount: 0 or more, at most 2 decimals. */
function moneyAmount(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    throw new Error(`${name} must be an amount in dollars, 0 or more, with at most 2 decimals (got "${raw}")`);
  }
  return n;
}
```

In the `AppConfig` interface, after `approvalTtlMinutes`:

```ts
  /** Which risky tool calls skip human review. Defaults to none. */
  approvalPolicy: ApprovalPolicyConfig;
```

In `loadConfig`, after the `approvalTtlMinutes:` line:

```ts
    approvalPolicy: { refundAutoApproveUnder: moneyAmount(env, 'REFUND_AUTO_APPROVE_UNDER', 0) },
```

- [ ] **Step 8: Document the variable**

In `.env.example`, after the `APPROVAL_TTL_MINUTES=1440` line, add:

```
# Refunds are approved automatically (and logged as such) when this refund plus earlier refunds on the
# same order stays under this many dollars. 0 or unset = every refund waits for a reviewer.
REFUND_AUTO_APPROVE_UNDER=0
```

- [ ] **Step 9: Run the tests and typecheck**

Run: `npm test -w apps/api -- policy.spec config.spec && npm run typecheck -w apps/api`
Expected: PASS, no type errors.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/agent/policy.ts apps/api/src/agent/policy.spec.ts apps/api/src/config.ts apps/api/src/config.spec.ts .env.example
git commit -m "Add approval policy module and REFUND_AUTO_APPROVE_UNDER config

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Audit data model and store

**Files:**
- Modify: `apps/api/src/agent/types.ts`
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/pg-agent.store.ts`
- Modify: `apps/api/test/fakes.ts`
- Create: `apps/api/test/audit-log.e2e-spec.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces (used by Tasks 3 and 4):
  ```ts
  export type ApprovalEventKind = 'requested' | 'auto_approved' | 'approved' | 'rejected' | 'expired';
  export type ApprovalActorType = 'reviewer' | 'system' | 'policy';
  export interface ApprovalEvent {
    id: number; kind: ApprovalEventKind; actionId: string | null; runId: string; conversationId: string;
    actorType: ApprovalActorType; actorId: string | null; toolName: string; toolArgs: Record<string, unknown>;
    rule: string | null; detail: Record<string, unknown> | null; note: string | null; createdAt: string;
  }
  export type NewApprovalEvent = Pick<ApprovalEvent, 'kind' | 'runId' | 'conversationId' | 'actorType' | 'toolName' | 'toolArgs'> &
    Partial<Pick<ApprovalEvent, 'actionId' | 'actorId' | 'rule' | 'detail' | 'note'>>;
  export interface DecisionAudit { kind: 'approved' | 'rejected' | 'expired'; actorType: 'reviewer' | 'system' }
  // NewAction gains: policy?: { rule: string; detail: Record<string, unknown> }
  // AgentStore gains:
  addApprovalEvent(event: NewApprovalEvent): Promise<ApprovalEvent>;
  listApprovalEvents(filter?: { conversationId?: string; limit?: number; before?: number }): Promise<ApprovalEvent[]>;
  // AgentStore.decideAction gains an optional 4th parameter: audit?: DecisionAudit
  //   (default: { kind: status, actorType: 'reviewer' })
  ```
  `ApprovalView` (in `pg-agent.store.ts`) gains `policyRule: string | null` and `policyDetail: Record<string, unknown> | null`. `MemoryStore` gains `events: ApprovalEvent[]`.

These e2e tests need Postgres. Locally: `npm run db:up`, then `export E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5432/aiagent_test` (create that database first: `docker compose exec db psql -U postgres -c 'CREATE DATABASE aiagent_test'`). **The e2e suite re-seeds the target database**, so never point it at data you care about.

- [ ] **Step 1: Write the failing store tests**

Create `apps/api/test/audit-log.e2e-spec.ts`:

```ts
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { PgAgentStore } from '../src/db/pg-agent.store';
import { seedDatabase } from '../src/db/seed-data';
import { PG_POOL } from '../src/tokens';

// Runs against a real Postgres; skipped unless E2E_DATABASE_URL is set (CI sets it).
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

maybe('approval audit log in the store (real Postgres)', () => {
  let app: INestApplication;
  let store: PgAgentStore;
  let pool: Pool;

  beforeEach(async () => {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init();
    store = app.get(PgAgentStore);
    pool = app.get(PG_POOL);
    await seedDatabase(pool);
  });
  afterEach(() => app?.close());

  const toolArgs = { orderId: 1, amount: 18.75, reason: 'damaged' };
  const park = async () => {
    const conv = await store.createConversation(1, 't');
    const run = await store.createRun(conv.id);
    const action = await store.createAction({
      runId: run.id, conversationId: conv.id, toolName: 'issue_refund', toolArgs, toolCallId: 'call_1', reasoning: 'r',
      policy: { rule: 'over_threshold', detail: { threshold: 10, priorRefunded: 0, amount: 18.75 } },
    });
    return { conv, run, action };
  };

  it('writes a requested event together with the action', async () => {
    const { action, run, conv } = await park();
    const events = await store.listApprovalEvents({ conversationId: conv.id });
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'requested', actionId: action.id, runId: run.id, conversationId: conv.id, actorType: 'policy', actorId: null,
        toolName: 'issue_refund', toolArgs, rule: 'over_threshold', detail: { threshold: 10, priorRefunded: 0, amount: 18.75 }, note: null,
      }),
    ]);
  });

  it('writes a requested event with no rule when the caller gave no policy', async () => {
    const conv = await store.createConversation(1, 't');
    const run = await store.createRun(conv.id);
    await store.createAction({ runId: run.id, conversationId: conv.id, toolName: 'issue_refund', toolArgs, toolCallId: 'c', reasoning: 'r' });
    expect(await store.listApprovalEvents({ conversationId: conv.id })).toEqual([
      expect.objectContaining({ kind: 'requested', rule: null, detail: null }),
    ]);
  });

  it('writes one decision event with the note and defaults the actor to a reviewer', async () => {
    const { action, conv } = await park();
    await store.decideAction(action.id, 'approved', 'looks fine');
    const [decision] = await store.listApprovalEvents({ conversationId: conv.id });
    expect(decision).toMatchObject({ kind: 'approved', actionId: action.id, actorType: 'reviewer', note: 'looks fine', toolArgs });
  });

  it('writes exactly one decision event when two decisions race', async () => {
    const { action, conv } = await park();
    const results = await Promise.all([
      store.decideAction(action.id, 'approved', 'a'),
      store.decideAction(action.id, 'rejected', 'b'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const kinds = (await store.listApprovalEvents({ conversationId: conv.id })).map((e) => e.kind);
    expect(kinds.filter((k) => k !== 'requested')).toHaveLength(1);
  });

  it('records an expiry as a system decision', async () => {
    const { action, conv } = await park();
    await store.decideAction(action.id, 'rejected', 'Expired: no reviewer decision within 1 minute.', { kind: 'expired', actorType: 'system' });
    expect((await store.listApprovalEvents({ conversationId: conv.id }))[0]).toMatchObject({ kind: 'expired', actorType: 'system' });
  });

  it('logs an auto-approval that has no action row', async () => {
    const conv = await store.createConversation(1, 't');
    const run = await store.createRun(conv.id);
    const saved = await store.addApprovalEvent({
      kind: 'auto_approved', runId: run.id, conversationId: conv.id, actorType: 'policy', toolName: 'issue_refund', toolArgs,
      rule: 'under_threshold', detail: { threshold: 25 },
    });
    expect(saved).toMatchObject({ id: expect.any(Number), actionId: null, rule: 'under_threshold', note: null });
  });

  it('lists newest first, filters by conversation, and pages with before', async () => {
    const a = await park();
    const b = await park();
    await store.decideAction(a.action.id, 'approved');
    await store.decideAction(b.action.id, 'rejected');

    const all = await store.listApprovalEvents();
    expect(all.map((e) => e.kind)).toEqual(['rejected', 'approved', 'requested', 'requested']);
    expect(all.map((e) => e.id)).toEqual([...all.map((e) => e.id)].sort((x, y) => y - x));

    expect((await store.listApprovalEvents({ conversationId: a.conv.id })).map((e) => e.kind)).toEqual(['approved', 'requested']);
    expect(await store.listApprovalEvents({ limit: 2 })).toHaveLength(2);
    const older = await store.listApprovalEvents({ before: all[1].id, limit: 10 });
    expect(older.map((e) => e.id)).toEqual(all.slice(2).map((e) => e.id));
  });

  it('exposes why a human was needed on the approval listing', async () => {
    const { action } = await park();
    const [view] = await store.listApprovals({ status: 'pending_approval' });
    expect(view).toMatchObject({ id: action.id, policyRule: 'over_threshold', policyDetail: { threshold: 10, priorRefunded: 0, amount: 18.75 } });
  });

  it('removes events with their conversation and is wiped by a re-seed', async () => {
    const { conv } = await park();
    await pool.query('DELETE FROM conversations WHERE id = $1', [conv.id]);
    expect(await store.listApprovalEvents({ conversationId: conv.id })).toEqual([]);

    await park();
    await seedDatabase(pool);
    expect(await store.listApprovalEvents()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5432/aiagent_test npm run test:e2e -w apps/api -- audit-log`
Expected: FAIL (type errors: `policy`, `listApprovalEvents` do not exist). Without `E2E_DATABASE_URL` the suite is skipped; the type errors still fail the file.

- [ ] **Step 3: Add the types**

In `apps/api/src/agent/types.ts`, replace the `NewAction` line:

```ts
export type NewAction = Pick<Action, 'runId' | 'conversationId' | 'toolName' | 'toolArgs' | 'toolCallId' | 'reasoning'> & {
  /** Why a human is needed; becomes the rule and detail of the `requested` audit event. */
  policy?: { rule: string; detail: Record<string, unknown> };
};

export type ApprovalEventKind = 'requested' | 'auto_approved' | 'approved' | 'rejected' | 'expired';
export type ApprovalActorType = 'reviewer' | 'system' | 'policy';

/** One immutable line of the approval audit log. */
export interface ApprovalEvent {
  id: number;
  kind: ApprovalEventKind;
  /** Null for auto-approved calls, which never create an action. */
  actionId: string | null;
  runId: string;
  conversationId: string;
  actorType: ApprovalActorType;
  /** Reserved for reviewer accounts; always null until they exist. */
  actorId: string | null;
  toolName: string;
  /** The call as it was at that moment. */
  toolArgs: Record<string, unknown>;
  rule: string | null;
  detail: Record<string, unknown> | null;
  note: string | null;
  createdAt: string;
}

export type NewApprovalEvent = Pick<ApprovalEvent, 'kind' | 'runId' | 'conversationId' | 'actorType' | 'toolName' | 'toolArgs'> &
  Partial<Pick<ApprovalEvent, 'actionId' | 'actorId' | 'rule' | 'detail' | 'note'>>;

/** What the decision event should say about who decided and how. */
export interface DecisionAudit {
  kind: 'approved' | 'rejected' | 'expired';
  actorType: 'reviewer' | 'system';
}
```

In the `AgentStore` interface, replace the `createAction` / `decideAction` lines and add the two new methods:

```ts
  /** Also writes the `requested` audit event, atomically. */
  createAction(action: NewAction): Promise<Action>;
  getAction(id: string): Promise<Action | null>;
  /** Atomic claim: only succeeds while the action is still pending_approval. Writes the decision event in the same transaction. */
  decideAction(id: string, status: 'approved' | 'rejected', note?: string, audit?: DecisionAudit): Promise<Action | null>;
  addApprovalEvent(event: NewApprovalEvent): Promise<ApprovalEvent>;
  /** Newest first. `before` is an event id to page from. */
  listApprovalEvents(filter?: { conversationId?: string; limit?: number; before?: number }): Promise<ApprovalEvent[]>;
```

(Keep the existing `getAction` line only once.)

- [ ] **Step 4: Add the table**

In `apps/api/src/db/schema.ts`, before the closing backtick of `SCHEMA_SQL` (after the `refunds_action_uniq` index), add:

```sql

-- Append-only: the application only ever inserts. Rows go away only with their conversation.
CREATE TABLE IF NOT EXISTS approval_events (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('requested', 'auto_approved', 'approved', 'rejected', 'expired')),
  action_id uuid REFERENCES actions(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('reviewer', 'system', 'policy')),
  actor_id text,
  tool_name text NOT NULL,
  tool_args jsonb NOT NULL,
  rule text,
  detail jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_events_conversation_idx ON approval_events (conversation_id, id);
CREATE INDEX IF NOT EXISTS approval_events_action_idx ON approval_events (action_id);
```

Change `RESET_SQL` to:

```ts
export const RESET_SQL =
  'TRUNCATE customers, orders, tickets, refunds, conversations, runs, steps, actions, approval_events RESTART IDENTITY CASCADE';
```

- [ ] **Step 5: Implement the Postgres store**

In `apps/api/src/db/pg-agent.store.ts`:

Update the type import to include the new types:

```ts
import type {
  Action, ActionStatus, AgentStore, ApprovalEvent, Conversation, DecisionAudit, NewAction, NewApprovalEvent, NewStep, Run, RunMeta, Step,
} from '../agent/types';
```

After the `TERMINAL` constant, add:

```ts
/** Satisfied by both Pool and PoolClient, so an event can be written inside or outside a transaction. */
type Db = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

const MAX_EVENTS = 200;
```

Extend `ApprovalView`:

```ts
  /** Why a human was needed, from the `requested` audit event. Null on approvals created before the log existed. */
  policyRule: string | null;
  policyDetail: Record<string, unknown> | null;
```

Replace `createAction` with:

```ts
  async createAction(a: NewAction): Promise<Action> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO actions (run_id, conversation_id, tool_name, tool_args, tool_call_id, reasoning)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [a.runId, a.conversationId, a.toolName, JSON.stringify(a.toolArgs), a.toolCallId, a.reasoning],
      );
      const action = camel<Action>(rows[0]);
      await this.insertEvent(client, {
        kind: 'requested', actionId: action.id, runId: a.runId, conversationId: a.conversationId, actorType: 'policy',
        toolName: a.toolName, toolArgs: a.toolArgs, rule: a.policy?.rule, detail: a.policy?.detail,
      });
      await client.query('COMMIT');
      return action;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
```

Replace `decideAction` with:

```ts
  async decideAction(
    id: string, status: 'approved' | 'rejected', note?: string,
    audit: DecisionAudit = { kind: status, actorType: 'reviewer' },
  ): Promise<Action | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE actions SET status = $2, decision_note = $3, decided_at = now()
         WHERE id = $1 AND status = 'pending_approval' RETURNING *`,
        [id, status, note ?? null],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const action = camel<Action>(rows[0]);
      await this.insertEvent(client, {
        kind: audit.kind, actionId: id, runId: action.runId, conversationId: action.conversationId, actorType: audit.actorType,
        toolName: action.toolName, toolArgs: action.toolArgs, note,
      });
      await client.query('COMMIT');
      return action;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private async insertEvent(db: Db, e: NewApprovalEvent): Promise<ApprovalEvent> {
    const { rows } = await db.query(
      `INSERT INTO approval_events (kind, action_id, run_id, conversation_id, actor_type, actor_id, tool_name, tool_args, rule, detail, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [e.kind, e.actionId ?? null, e.runId, e.conversationId, e.actorType, e.actorId ?? null, e.toolName,
       JSON.stringify(e.toolArgs), e.rule ?? null, e.detail ? JSON.stringify(e.detail) : null, e.note ?? null],
    );
    return camel<ApprovalEvent>(rows[0]);
  }

  addApprovalEvent(e: NewApprovalEvent): Promise<ApprovalEvent> {
    return this.insertEvent(this.pool, e);
  }

  async listApprovalEvents(filter: { conversationId?: string; limit?: number; before?: number } = {}): Promise<ApprovalEvent[]> {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), MAX_EVENTS);
    const { rows } = await this.pool.query(
      `SELECT * FROM approval_events
       WHERE ($1::uuid IS NULL OR conversation_id = $1) AND ($2::bigint IS NULL OR id < $2)
       ORDER BY id DESC LIMIT $3`,
      [filter.conversationId ?? null, filter.before ?? null, limit],
    );
    return rows.map((r) => camel<ApprovalEvent>(r));
  }
```

In `listApprovals`, add two columns to the SELECT list, after the `order_refunded` expression (mind the comma):

```sql
         COALESCE((SELECT SUM(amount) FROM refunds r WHERE r.order_id = o.id), 0) AS order_refunded,
         (SELECT e.rule FROM approval_events e WHERE e.action_id = a.id AND e.kind = 'requested' ORDER BY e.id LIMIT 1) AS policy_rule,
         (SELECT e.detail FROM approval_events e WHERE e.action_id = a.id AND e.kind = 'requested' ORDER BY e.id LIMIT 1) AS policy_detail
```

- [ ] **Step 6: Mirror it in the in-memory fake**

In `apps/api/test/fakes.ts`, extend the type import with `ApprovalEvent, DecisionAudit, NewApprovalEvent`.

In `MemoryStore`, add a field next to `actions`:

```ts
  events: ApprovalEvent[] = [];
```

Replace `createAction` and `decideAction`:

```ts
  async createAction({ policy, ...a }: NewAction) {
    const action: Action = { ...a, id: `act-${++this.n}`, status: 'pending_approval', decisionNote: null, result: null, createdAt: '', decidedAt: null };
    this.actions.set(action.id, action);
    await this.addApprovalEvent({
      kind: 'requested', actionId: action.id, runId: a.runId, conversationId: a.conversationId, actorType: 'policy',
      toolName: a.toolName, toolArgs: a.toolArgs, rule: policy?.rule, detail: policy?.detail,
    });
    return { ...action };
  }
  async getAction(id: string) { const a = this.actions.get(id); return a ? { ...a } : null; }
  async decideAction(
    id: string, status: 'approved' | 'rejected', note?: string,
    audit: DecisionAudit = { kind: status, actorType: 'reviewer' },
  ) {
    const a = this.actions.get(id);
    if (!a || a.status !== 'pending_approval') return null;
    Object.assign(a, { status, decisionNote: note ?? null, decidedAt: new Date().toISOString() });
    await this.addApprovalEvent({
      kind: audit.kind, actionId: id, runId: a.runId, conversationId: a.conversationId, actorType: audit.actorType,
      toolName: a.toolName, toolArgs: a.toolArgs, note,
    });
    return { ...a };
  }
  async addApprovalEvent(e: NewApprovalEvent) {
    const event: ApprovalEvent = {
      id: this.events.length + 1, actionId: null, actorId: null, rule: null, detail: null, note: null, createdAt: '',
      ...(Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as object),
    } as ApprovalEvent;
    this.events.push(event);
    return event;
  }
  async listApprovalEvents(filter: { conversationId?: string; limit?: number; before?: number } = {}) {
    return this.events
      .filter((e) => (!filter.conversationId || e.conversationId === filter.conversationId) && (filter.before === undefined || e.id < filter.before))
      .sort((x, y) => y.id - x.id)
      .slice(0, filter.limit ?? 100);
  }
```

Remove the old `createAction` and `decideAction` bodies they replace.

- [ ] **Step 7: Run typecheck, unit tests and the store e2e**

Run: `npm run typecheck -w apps/api && npm test -w apps/api -- --testPathIgnorePatterns e2e && E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5432/aiagent_test npm run test:e2e -w apps/api -- audit-log`
Expected: typecheck clean, existing unit tests still PASS, all `audit-log` e2e tests PASS.

- [ ] **Step 8: Run the existing e2e suites to check nothing regressed**

Run: `E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5432/aiagent_test npm run test:e2e -w apps/api`
Expected: PASS (the existing three-argument `decideAction` calls still work).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/agent/types.ts apps/api/src/db/schema.ts apps/api/src/db/pg-agent.store.ts apps/api/test/fakes.ts apps/api/test/audit-log.e2e-spec.ts
git commit -m "Add approval_events audit table and transactional event writes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Runner integration

**Files:**
- Modify: `apps/api/src/agent/tools.ts`
- Modify: `apps/api/src/agent/runner.ts`
- Modify: `apps/api/src/agent/approval-expiry.ts`
- Modify: `apps/api/src/agent/agent.module.ts`
- Modify: `apps/api/src/agent/runner.spec.ts`
- Modify: `apps/api/src/agent/approval-expiry.spec.ts`

**Interfaces:**
- Consumes: `evaluateApproval`, `ApprovalPolicyConfig`, `ApprovalFacts` (Task 1); `NewAction.policy`, `DecisionAudit`, `store.addApprovalEvent`, `MemoryStore.events` (Task 2); `AppConfig.approvalPolicy` (Task 1).
- Produces:
  - `RunnerDeps.approvalPolicy?: ApprovalPolicyConfig` (default `{ refundAutoApproveUnder: 0 }`).
  - `AgentRunner.decide(actionId, decision, note?, actor: 'reviewer' | 'system' = 'reviewer')`. `'system'` is the expiry sweep and logs as `expired`.
  - `ToolDef.preflight` now returns `Promise<ApprovalFacts | void>`.

- [ ] **Step 1: Write the failing runner tests**

Append to `apps/api/src/agent/runner.spec.ts`:

```ts
describe('approval policy', () => {
  const build = (refundAutoApproveUnder: number) => {
    const shop = new MemoryShop();
    const store = new MemoryStore();
    const runner = new AgentRunner({ provider: new MockProvider(), shop, store, approvalPolicy: { refundAutoApproveUnder } });
    return { shop, store, runner, newConversation: (customerId = 1) => store.addConversation(customerId) };
  };

  it('refunds under the threshold without a reviewer, and logs the policy decision', async () => {
    const { runner, store, shop, newConversation } = build(100);
    const run = await runner.handleUserMessage(newConversation(), 'Order #1 arrived damaged, please refund it');

    expect(run.status).toBe('completed');
    expect(store.actions.size).toBe(0); // nothing was parked
    expect(shop.refunds).toEqual([expect.objectContaining({ orderId: 1, amount: 50, actionId: undefined })]);
    expect(store.steps.at(-1)?.content).toContain('approved and issued');
    expect(store.events).toEqual([
      expect.objectContaining({
        kind: 'auto_approved', actorType: 'policy', actionId: null, toolName: 'issue_refund', toolArgs: expect.objectContaining({ orderId: 1, amount: 50 }),
        rule: 'under_threshold', detail: { threshold: 100, priorRefunded: 0, amount: 50 },
      }),
    ]);
  });

  it('parks a refund of exactly the threshold and says why', async () => {
    const { runner, store, shop, newConversation } = build(50);
    const run = await runner.handleUserMessage(newConversation(), 'refund order #1');

    expect(run.status).toBe('awaiting_approval');
    expect(shop.refunds).toHaveLength(0);
    expect(store.events).toEqual([
      expect.objectContaining({ kind: 'requested', actorType: 'policy', rule: 'over_threshold', detail: { threshold: 50, priorRefunded: 0, amount: 50 } }),
    ]);
  });

  it('keeps asking a human for every refund when no threshold is set', async () => {
    const { runner, store, newConversation } = build(0);
    const run = await runner.handleUserMessage(newConversation(), 'refund order #1 $1');
    expect(run.status).toBe('awaiting_approval');
    expect(store.events).toEqual([expect.objectContaining({ kind: 'requested', rule: 'always_review' })]);
  });

  it('counts earlier refunds on the order, so a big refund cannot be split into small ones', async () => {
    const { runner, store, shop, newConversation } = build(40);
    shop.refunds.push({ id: 1, orderId: 1, amount: 30, reason: 'earlier' });

    const big = await runner.handleUserMessage(newConversation(), 'refund order #1 $15'); // 30 + 15 = 45, not under 40
    expect(big.status).toBe('awaiting_approval');

    const small = await runner.handleUserMessage(newConversation(), 'refund order #1 $5'); // 30 + 5 = 35, under 40
    expect(small.status).toBe('completed');
    expect(shop.refunds.map((r) => r.amount)).toEqual([30, 5]);
    expect(store.events.map((e) => e.kind)).toEqual(['requested', 'auto_approved']);
  });

  it('writes the audit event before the refund runs', async () => {
    const { runner, store, shop, newConversation } = build(100);
    const seen: string[][] = [];
    const createRefund = shop.createRefund.bind(shop);
    shop.createRefund = async (input) => {
      seen.push(store.events.map((e) => e.kind));
      return createRefund(input);
    };
    await runner.handleUserMessage(newConversation(), 'refund order #1');
    expect(seen).toEqual([['auto_approved']]);
  });

  it('does not refund, and fails the run, when the audit event cannot be written', async () => {
    const { runner, store, shop, newConversation } = build(100);
    store.addApprovalEvent = async () => { throw new Error('audit down'); };

    await expect(runner.handleUserMessage(newConversation(), 'refund order #1')).rejects.toThrow('audit down');
    expect(shop.refunds).toHaveLength(0);
    expect([...store.runs.values()][0].status).toBe('failed');
  });

  it('still applies the guardrails to a call the policy would auto-approve', async () => {
    const { runner, store, shop, newConversation } = build(1000);

    const over = await runner.handleUserMessage(newConversation(), 'refund order #1 for $500');
    expect(over.status).toBe('completed');
    expect(store.steps.find((s) => s.toolName === 'issue_refund' && s.role === 'tool')?.result).toMatchObject({ code: 'OVER_REFUND' });

    const crossConv = newConversation();
    const cross = await runner.handleUserMessage(crossConv, 'refund order #2'); // belongs to customer 2
    expect(cross.status).toBe('completed');
    expect(store.steps.find((s) => s.role === 'tool' && s.toolName === 'get_order' && s.conversationId === crossConv.id)?.result)
      .toMatchObject({ code: 'CROSS_CUSTOMER' });

    expect(shop.refunds).toHaveLength(0);
    expect(store.events).toEqual([]); // nothing was decided, so nothing is logged
  });
});

describe('audit events for human decisions', () => {
  it('logs requested, then the reviewer decision with its note', async () => {
    const { runner, store, conv } = setup();
    await runner.handleUserMessage(conv, 'refund order #1');
    const [action] = [...store.actions.values()];
    await runner.decide(action.id, 'approve', 'Looks legitimate');

    expect(store.events.map((e) => [e.kind, e.actorType])).toEqual([['requested', 'policy'], ['approved', 'reviewer']]);
    expect(store.events[1]).toMatchObject({ actionId: action.id, note: 'Looks legitimate', toolName: 'issue_refund' });
  });

  it('logs a rejection as rejected, and a system decision as expired', async () => {
    const { runner, store, conv } = setup();
    await runner.handleUserMessage(conv, 'refund order #1');
    const [first] = [...store.actions.values()];
    await runner.decide(first.id, 'reject', 'Outside policy');
    expect(store.events.at(-1)).toMatchObject({ kind: 'rejected', actorType: 'reviewer' });

    const other = store.addConversation(2);
    await runner.handleUserMessage(other, 'refund order #2');
    const second = [...store.actions.values()].find((a) => a.conversationId === other.id)!;
    await runner.decide(second.id, 'reject', 'Expired: no reviewer decision within 1 minute.', 'system');
    expect(store.events.at(-1)).toMatchObject({ kind: 'expired', actorType: 'system', actionId: second.id });
  });

  it('logs no second decision for a double click', async () => {
    const { runner, store, conv } = setup();
    await runner.handleUserMessage(conv, 'refund order #1');
    const [action] = [...store.actions.values()];
    await runner.decide(action.id, 'approve');
    await expect(runner.decide(action.id, 'approve')).rejects.toBeInstanceOf(ConflictError);
    expect(store.events.filter((e) => e.kind === 'approved')).toHaveLength(1);
  });
});
```

Add to the `describe('ApprovalExpiry', ...)` block in `apps/api/src/agent/approval-expiry.spec.ts`, after the first test:

```ts
  it('logs an expiry as a system decision, not a reviewer rejection', async () => {
    const { expiry, park, store } = setup();
    const stale = await park(1, 'refund order #1', 25 * HOUR);
    await expiry.sweep();
    const event = store.events.find((e) => e.actionId === stale.action.id && e.kind !== 'requested');
    expect(event).toMatchObject({ kind: 'expired', actorType: 'system', note: expect.stringContaining('Expired') });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w apps/api -- runner.spec approval-expiry.spec`
Expected: FAIL (`approvalPolicy` is not a known `RunnerDeps` property; `decide` takes no fourth argument).

- [ ] **Step 3: Let `preflight` return facts**

In `apps/api/src/agent/tools.ts`, add the import:

```ts
import type { ApprovalFacts } from './policy';
```

Change the `preflight` member of `ToolDef`:

```ts
  /** Policy checks run before a risky call is parked (and again when executing). Returns what the approval policy should weigh. */
  preflight?: (ctx: ToolContext, args: any) => Promise<ApprovalFacts | void>;
```

Change `issue_refund`'s `preflight`:

```ts
    async preflight(ctx, { orderId, amount }: { orderId: number; amount: number }) {
      const order = await loadOwnedOrder(ctx, orderId);
      const priorRefunded = await ctx.shop.totalRefunded(orderId);
      assertRefundable({ amount, orderTotal: order.total, priorRefunded, status: order.status });
      return { priorRefunded };
    },
```

- [ ] **Step 4: Wire the policy into the runner**

In `apps/api/src/agent/runner.ts`:

Add imports:

```ts
import { evaluateApproval, type ApprovalPolicyConfig } from './policy';
```

and add `DecisionAudit` to the `./types` import list.

Add to `RunnerDeps`:

```ts
  /** Which risky calls skip human review. Default: none, every risky call waits for a reviewer. */
  approvalPolicy?: ApprovalPolicyConfig;
```

Replace the `Outcome` type:

```ts
type Outcome =
  | { kind: 'result'; result: unknown }
  | { kind: 'pending'; reasoning: string; rule: string; detail: Record<string, unknown> };
```

Add a field and set it in the constructor:

```ts
  private readonly policy: ApprovalPolicyConfig;
```

```ts
    this.policy = deps.approvalPolicy ?? { refundAutoApproveUnder: 0 };
```

Replace `decide`:

```ts
  /**
   * Applies a decision to a parked action and resumes the paused run. `actor` is 'system' only for the expiry
   * sweep, which is logged as `expired` rather than as a reviewer's rejection.
   */
  async decide(
    actionId: string, decision: 'approve' | 'reject', note?: string, actor: 'reviewer' | 'system' = 'reviewer',
  ): Promise<{ action: Action; run: Run }> {
    const { store } = this.deps;
    if (!(await store.getAction(actionId))) throw new NotFoundError(`Approval ${actionId} not found`);
    const audit: DecisionAudit = {
      kind: actor === 'system' ? 'expired' : decision === 'approve' ? 'approved' : 'rejected',
      actorType: actor,
    };
    const action = await store.decideAction(actionId, decision === 'approve' ? 'approved' : 'rejected', note, audit);
    if (!action) throw new ConflictError('This approval has already been decided');

    return this.complete(action, decision, note);
  }
```

In `loop`, change the call and the `createAction` call:

```ts
          const outcome = await this.execute(conv, run.id, call, completion.text ?? '');
          if (outcome.kind === 'pending') {
            await store.createAction({
              runId: run.id, conversationId: conv.id, toolName: call.name,
              toolArgs: call.args as Record<string, unknown>, toolCallId: call.id, reasoning: outcome.reasoning,
              policy: { rule: outcome.rule, detail: outcome.detail },
            });
```

Replace `execute`:

```ts
  /** Unknown tool -> invalid args -> guardrails -> approval policy -> (park | execute). Failures become tool results, not exceptions. */
  private async execute(conv: Conversation, runId: string, call: ToolCall, thought: string): Promise<Outcome> {
    const tool = toolByName(call.name);
    if (!tool) return { kind: 'result', result: { error: `Unknown tool "${call.name}"`, code: 'UNKNOWN_TOOL' } };

    const check = validateToolInput(call.name, call.args);
    if (!check.ok) {
      return { kind: 'result', result: { error: `Invalid arguments: ${check.errors.join('; ')}`, code: 'INVALID_ARGUMENTS' } };
    }
    const ctx = this.ctx(conv);
    try {
      if (tool.risky) {
        const facts = (await tool.preflight?.(ctx, call.args)) ?? {};
        const decision = evaluateApproval(call.name, call.args, facts, this.policy);
        if (decision.mode === 'auto') {
          // The decision is on record before anything happens: if it cannot be written, the tool does not run.
          await this.deps.store.addApprovalEvent({
            kind: 'auto_approved', runId, conversationId: conv.id, actorType: 'policy', toolName: call.name,
            toolArgs: call.args as Record<string, unknown>, rule: decision.rule, detail: decision.detail,
          });
          return { kind: 'result', result: await tool.execute(ctx, call.args) };
        }
        const reason = (call.args as { reason?: string }).reason;
        return {
          kind: 'pending', rule: decision.rule, detail: decision.detail,
          reasoning: thought || `The agent requested ${call.name}${reason ? `: ${reason}` : ''}`,
        };
      }
      return { kind: 'result', result: await tool.execute(ctx, call.args) };
    } catch (e) {
      if (e instanceof GuardrailViolation) return { kind: 'result', result: guardrailResult(e) };
      throw e;
    }
  }
```

- [ ] **Step 5: Mark expiry as the system actor**

In `apps/api/src/agent/approval-expiry.ts`, change the reject call:

```ts
        await runner.decide(action.id, 'reject', note, 'system');
```

- [ ] **Step 6: Pass the config in the module**

In `apps/api/src/agent/agent.module.ts`, add `approvalPolicy: cfg.approvalPolicy` to the `AgentRunner` options:

```ts
        new AgentRunner({ provider, shop, store, maxSteps: cfg.maxSteps, tokenBudget: cfg.conversationTokenBudget,
          maxContextTokens: cfg.contextMaxTokens, approvalPolicy: cfg.approvalPolicy }),
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npm run typecheck -w apps/api && npm test -w apps/api -- --testPathIgnorePatterns e2e`
Expected: all unit tests PASS, including the new ones and every pre-existing runner/expiry test.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/agent apps/api/test
git commit -m "Route risky tool calls through the approval policy and log decisions

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Events endpoint and HTTP end-to-end

**Files:**
- Modify: `apps/api/src/http/dto.ts`
- Modify: `apps/api/src/http/approvals.controller.ts`
- Modify: `apps/api/test/audit-log.e2e-spec.ts`

**Interfaces:**
- Consumes: `PgAgentStore.listApprovalEvents`, `ApprovalView.policyRule/policyDetail` (Task 2); runner policy (Task 3).
- Produces: `GET /approvals/events?conversationId=&limit=&before=` returning `ApprovalEvent[]`, reviewer-guarded.

- [ ] **Step 1: Write the failing HTTP tests**

In `apps/api/test/audit-log.e2e-spec.ts`, add imports at the top:

```ts
import request from 'supertest';
import { configureApp } from '../src/http/setup';
```

Append this block to the end of the file:

```ts
maybe('approval audit log over HTTP (real Postgres)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());
  const reviewer = { Authorization: 'Bearer s3cret' };

  const boot = async (env: Record<string, string> = {}) => {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    process.env.REVIEWER_API_KEY = 's3cret';
    Object.assign(process.env, env);
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    configureApp(app);
    await app.init();
    await seedDatabase(app.get(PG_POOL));
  };
  const start = async (customerId: number) => {
    const res = await http().post('/conversations').send({ customerId }).expect(201);
    return { id: res.body.id as string, token: { 'x-conversation-token': res.body.accessToken as string } };
  };
  const say = (c: { id: string; token: object }, content: string) =>
    http().post(`/conversations/${c.id}/messages`).set(c.token).send({ content }).expect(201);

  afterEach(async () => {
    await app?.close();
    delete process.env.REVIEWER_API_KEY;
    delete process.env.REFUND_AUTO_APPROVE_UNDER;
  });

  describe('with the default policy (every refund reviewed)', () => {
    beforeEach(() => boot());

    it('logs requested then approved, newest first, and explains the wait on the approval', async () => {
      const c = await start(1);
      await say(c, 'Order #1 arrived damaged, please refund it');

      const [pending] = (await http().get('/approvals?status=pending').set(reviewer).expect(200)).body;
      expect(pending).toMatchObject({ policyRule: 'always_review' });
      await http().post(`/approvals/${pending.id}`).set(reviewer).send({ decision: 'approve', note: 'ok' }).expect(201);

      const events = (await http().get('/approvals/events').set(reviewer).expect(200)).body;
      expect(events.map((e: any) => [e.kind, e.actorType])).toEqual([['approved', 'reviewer'], ['requested', 'policy']]);
      expect(events[0]).toMatchObject({ actionId: pending.id, note: 'ok', actorId: null, toolName: 'issue_refund' });
      expect(events[0].toolArgs).toMatchObject({ orderId: 1, amount: 18.75 });
    });

    it('filters by conversation and pages with limit and before', async () => {
      const a = await start(1);
      const b = await start(2);
      await say(a, 'refund order #1');
      await say(b, 'refund order #12');

      const mine = (await http().get(`/approvals/events?conversationId=${a.id}`).set(reviewer).expect(200)).body;
      expect(mine).toHaveLength(1);
      expect(mine[0].conversationId).toBe(a.id);

      const first = (await http().get('/approvals/events?limit=1').set(reviewer).expect(200)).body;
      expect(first).toHaveLength(1);
      const rest = (await http().get(`/approvals/events?limit=10&before=${first[0].id}`).set(reviewer).expect(200)).body;
      expect(rest).toHaveLength(1);
      expect(rest[0].id).toBeLessThan(first[0].id);
    });

    it('rejects bad query input with 400, not a database error', async () => {
      for (const q of ['limit=0', 'limit=201', 'limit=many', 'before=0', 'before=abc', 'conversationId=nope', 'extra=1']) {
        await http().get(`/approvals/events?${q}`).set(reviewer).expect(400);
      }
    });

    it('is for reviewers only: a conversation token is not enough', async () => {
      const c = await start(1);
      await http().get('/approvals/events').expect(401);
      await http().get('/approvals/events').set(c.token).expect(401);
      await http().get('/approvals/events').set(reviewer).expect(200);
    });

    it('never puts events or policy details in the customer view of a conversation', async () => {
      const c = await start(1);
      await say(c, 'refund order #1');
      const trace = (await http().get(`/conversations/${c.id}`).set(c.token).expect(200)).body;
      expect(JSON.stringify(trace)).not.toContain('auto_approved');
      expect(JSON.stringify(trace)).not.toContain('"events"');
    });
  });

  describe('with REFUND_AUTO_APPROVE_UNDER=25', () => {
    beforeEach(() => boot({ REFUND_AUTO_APPROVE_UNDER: '25' }));

    it('refunds order #1 (18.75) at once, logs auto_approved, and leaves no approval or action_id', async () => {
      const c = await start(1);
      const sent = await say(c, 'Order #1 arrived damaged, please refund it');
      expect(sent.body.run.status).toBe('completed');

      expect((await http().get('/approvals').set(reviewer).expect(200)).body).toEqual([]);
      const pool = app.get<Pool>(PG_POOL);
      const { rows } = await pool.query('SELECT amount::float AS amount, action_id FROM refunds WHERE order_id = 1');
      expect(rows).toEqual([{ amount: 18.75, action_id: null }]);

      const events = (await http().get('/approvals/events').set(reviewer).expect(200)).body;
      expect(events).toEqual([
        expect.objectContaining({
          kind: 'auto_approved', actorType: 'policy', actionId: null, rule: 'under_threshold',
          detail: { threshold: 25, priorRefunded: 0, amount: 18.75 },
        }),
      ]);
    });

    it('still parks a refund that would push the order to the threshold', async () => {
      const c = await start(2); // order 12: total 66.99, 10.00 already refunded, 56.99 refundable
      const sent = await say(c, 'refund order #12');
      expect(sent.body.run.status).toBe('awaiting_approval');
      const [approval] = (await http().get('/approvals?status=pending').set(reviewer).expect(200)).body;
      expect(approval).toMatchObject({ policyRule: 'over_threshold', policyDetail: { threshold: 25, priorRefunded: 10, amount: 56.99 } });
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5432/aiagent_test npm run test:e2e -w apps/api -- audit-log`
Expected: the new HTTP tests FAIL (404 for `/approvals/events`, which is currently captured as no route).

- [ ] **Step 3: Add the query DTO**

In `apps/api/src/http/dto.ts`, change the first two imports:

```ts
import { Transform, Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
```

Append:

```ts
export class ListApprovalEventsQuery {
  @IsOptional() @IsUUID()
  conversationId?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  /** Event id to page from: returns events older than it. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  before?: number;
}
```

- [ ] **Step 4: Add the route**

In `apps/api/src/http/approvals.controller.ts`, change the dto import to `import { DecideApprovalDto, ListApprovalEventsQuery, ListApprovalsQuery } from './dto';` and add, after `list`:

```ts
  /** The append-only audit log of approval decisions, newest first. */
  @Get('events')
  events(@Query() q: ListApprovalEventsQuery) {
    return this.store.listApprovalEvents(q);
  }
```

- [ ] **Step 5: Run the HTTP tests**

Run: `E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5432/aiagent_test npm run test:e2e -w apps/api -- audit-log`
Expected: PASS.

Possible failure to investigate rather than paper over: the `rest` paging assertion assumes exactly two events exist for the two parked conversations. If the mock for customer 2 behaves differently, print `events` and adjust the expected count to what was actually created, not the other way round.

- [ ] **Step 6: Run the whole API suite and typecheck**

Run: `npm run typecheck -w apps/api && E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5432/aiagent_test npm test -w apps/api`
Expected: PASS (unit and e2e).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/http apps/api/test/audit-log.e2e-spec.ts
git commit -m "Add GET /approvals/events and cover the policy flow over HTTP

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Reviewer console

**Files:**
- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/policy.ts`
- Create: `apps/web/src/components/AuditLog.tsx`
- Modify: `apps/web/src/components/ApprovalsPanel.tsx`
- Modify: `apps/web/src/app/reviewer/page.tsx`
- Modify: `apps/web/src/app/globals.css`

**Interfaces:**
- Consumes: `GET /approvals/events` and `Approval.policyRule/policyDetail` from the API (Tasks 2 and 4).
- Produces: an "Audit log" tab in the reviewer console and a policy hint on approval cards. There is no web test runner yet (TODO 5.2), so this task is verified by typecheck, build and a manual run.

- [ ] **Step 1: Add the types**

In `apps/web/src/lib/types.ts`, add to `Approval`:

```ts
  /** Why a human was needed (from the audit log); null for approvals created before the log existed. */
  policyRule: string | null;
  policyDetail: { threshold?: number; priorRefunded?: number; amount?: number } | null;
```

and append:

```ts
export interface ApprovalEvent {
  id: number;
  kind: 'requested' | 'auto_approved' | 'approved' | 'rejected' | 'expired';
  actionId: string | null;
  runId: string;
  conversationId: string;
  actorType: 'reviewer' | 'system' | 'policy';
  actorId: string | null;
  toolName: string;
  toolArgs: { orderId?: number; amount?: number; reason?: string };
  rule: string | null;
  detail: { threshold?: number; priorRefunded?: number; amount?: number } | null;
  note: string | null;
  createdAt: string;
}
```

- [ ] **Step 2: Add the API call**

In `apps/web/src/lib/api.ts`, extend the type import with `ApprovalEvent` and add to `api` after `decide`:

```ts
  approvalEvents: (auth: Auth) => call<ApprovalEvent[]>('/approvals/events?limit=100', {}, auth),
```

- [ ] **Step 3: Add the rule wording**

Create `apps/web/src/lib/policy.ts`:

```ts
/** Human wording for an approval-policy rule; null when there is nothing useful to say. */
export function describeRule(rule: string | null, detail: { threshold?: number } | null): string | null {
  const limit = detail?.threshold != null ? `$${detail.threshold.toFixed(2)} auto-approve limit` : 'auto-approve limit';
  switch (rule) {
    case 'always_review': return 'Every refund needs review';
    case 'over_threshold': return `Over the ${limit}`;
    case 'under_threshold': return `Under the ${limit}`;
    default: return null;
  }
}
```

- [ ] **Step 4: Add the audit log component**

Create `apps/web/src/components/AuditLog.tsx`:

```tsx
import { describeRule } from '@/lib/policy';
import type { ApprovalEvent } from '@/lib/types';

const usd = (n: number | undefined) => (n == null ? '' : `$${n.toFixed(2)}`);
const KIND: Record<ApprovalEvent['kind'], string> = {
  requested: 'Review requested', auto_approved: 'Auto-approved', approved: 'Approved', rejected: 'Rejected', expired: 'Expired',
};
const WHO: Record<ApprovalEvent['actorType'], string> = { reviewer: 'Reviewer', system: 'System', policy: 'Policy' };

export function AuditLog({ events }: { events: ApprovalEvent[] }) {
  if (events.length === 0) return <div className="empty pad">No approval decisions yet.</div>;
  return (
    <ol className="audit">
      {events.map((e) => {
        const rule = describeRule(e.rule, e.detail);
        return (
          <li key={e.id} className="audit-row">
            <div className="audit-top">
              <span className={`chip ${e.kind}`}>{KIND[e.kind]}</span>
              <time className="muted" dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString()}</time>
            </div>
            <div>
              <b>{e.toolName === 'issue_refund' ? `Refund · order #${e.toolArgs.orderId}` : e.toolName}</b>
              {e.toolArgs.amount != null && <span className="amount"> {usd(e.toolArgs.amount)}</span>}
            </div>
            <div className="muted">
              {WHO[e.actorType]}{rule && ` · ${rule}`}{e.note && ` · “${e.note}”`}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 5: Show why a human is needed on pending cards**

In `apps/web/src/components/ApprovalsPanel.tsx`, add the import:

```tsx
import { describeRule } from '@/lib/policy';
```

Inside `Card`, after `const remaining = ...`:

```tsx
  const why = a.status === 'pending_approval' ? describeRule(a.policyRule, a.policyDetail) : null;
```

and render it directly under the `approval-top` div:

```tsx
      {why && <div className="chip warn">{why}</div>}
```

- [ ] **Step 6: Add the tab**

In `apps/web/src/app/reviewer/page.tsx`:

Add `AuditLog` to the imports (`import { AuditLog } from '@/components/AuditLog';`) and `ApprovalEvent` to the types import.

Add state beside `approvals`:

```tsx
  const [events, setEvents] = useState<ApprovalEvent[]>([]);
```

Change the `tab` state type:

```tsx
  const [tab, setTab] = useState<'trace' | 'approvals' | 'audit'>('trace');
```

In `refresh`, fetch events only while that tab is open:

```tsx
      const [list, apps, d, evs] = await Promise.all([
        api.conversations(auth),
        api.approvals(auth),
        selectedId ? api.conversation(selectedId, auth) : Promise.resolve(null),
        tab === 'audit' ? api.approvalEvents(auth) : Promise.resolve(null),
      ]);
      setConversations(list); setApprovals(apps); setError(null);
      if (d) setDetail(d);
      if (evs) setEvents(evs);
```

and add `tab` to the `useCallback` dependency list: `[locked, key, selectedId, tab]`.

Add the third tab button after the Approvals button:

```tsx
          <button role="tab" aria-selected={tab === 'audit'} className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}>Audit log</button>
```

Replace the tab body expression:

```tsx
          {tab === 'trace' && <TracePanel detail={detail} />}
          {tab === 'approvals' && <ApprovalsPanel approvals={approvals} onDecide={decide} />}
          {tab === 'audit' && <AuditLog events={events} />}
```

- [ ] **Step 7: Style it**

In `apps/web/src/app/globals.css`, after the `.chip.running` line add:

```css
.chip.requested { background: var(--warn-soft); color: var(--warn); }
.chip.auto_approved { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
.chip.expired { background: var(--code); color: var(--muted); }
```

and after the `.approval dt` rule add:

```css
.audit { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.audit-row { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; display: grid; gap: 4px; font-size: 13px; }
.audit-top { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
```

- [ ] **Step 8: Typecheck and build**

Run: `npm run typecheck -w apps/web && npm run build -w apps/web`
Expected: no type errors, build succeeds.

- [ ] **Step 9: Verify in the running app**

Run: `REFUND_AUTO_APPROVE_UNDER=25 npm run dev` (after `npm run db:up && npm run seed`). Then:
1. Open <http://localhost:3000>, start a chat as Ava and send `Order #1 arrived damaged, please refund it`. Expected: the agent answers that the refund was issued, with no approval step.
2. Open <http://localhost:3000/reviewer> → **Audit log**. Expected: one outlined "Auto-approved" row, "Policy · Under the $25.00 auto-approve limit".
3. Start a chat as Ben and send `refund order #12`. Expected: it waits; in **Approvals** the card shows "Over the $25.00 auto-approve limit".
4. Approve it. Expected: the **Audit log** tab shows "Approved · Reviewer" above "Review requested".

If you cannot run the browser, say so in the task report instead of claiming the UI works.

- [ ] **Step 10: Commit**

```bash
git add apps/web
git commit -m "Show the approval audit log and policy hints in the reviewer console

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Docs, TODO and final verification

**Files:**
- Modify: `README.md`
- Modify: `TODO.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Update the README**

In `README.md`:

1. In the configuration table, after the `APPROVAL_TTL_MINUTES` row, add:

```
| `REFUND_AUTO_APPROVE_UNDER` | `0` | Dollars. A refund is approved automatically (and logged as `auto_approved`) when it plus earlier refunds on the same order stays strictly under this amount. `0` = every refund waits for a reviewer |
```

2. In the endpoint table, after the `GET /approvals?status=pending` row, add:

```
| `GET /approvals/events` | 🔒 Append-only audit log of approval decisions, newest first (`conversationId`, `limit` up to 200, `before` event id). Kinds: `requested`, `auto_approved`, `approved`, `rejected`, `expired` |
```

3. In the "Human-in-the-loop" feature bullet, append: ` Refunds under \`REFUND_AUTO_APPROVE_UNDER\` skip the queue, and every decision, automatic or human, lands in the audit log.`

4. In the security notes, add a bullet after the "Approvals expire" one:

```
- **Auto-approval is opt-in and cumulative.** With `REFUND_AUTO_APPROVE_UNDER` unset nothing is auto-approved. When set, the check counts earlier refunds on the order, so a large refund cannot be split into small ones; it does not cap refunds across a customer's different orders. Two conversations of one customer approving at the same instant could briefly exceed the threshold on one order; the order total still caps it. The `auto_approved` event is written before the refund runs, and the refund does not run if the event cannot be written.
```

5. In the "Real identity" bullet near the end, change "and an audit log (see Security notes)" to "and four-eyes approval (see Security notes); decisions are already logged, but the log does not yet say *which* reviewer decided".

- [ ] **Step 2: Tick the TODO**

In `TODO.md`, change items 4.2 and 4.3 to checked:

```
- [x] 4.2 Threshold-based approval policy per tool.
- [x] 4.3 Audit log of approval decisions, shown in the reviewer console.
```

- [ ] **Step 3: Final verification**

Run the complete suite against a disposable database and confirm each result yourself before reporting:

```bash
npm run typecheck
E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5432/aiagent_test npm test
npm run build
```

Expected: typecheck clean, all unit and e2e tests PASS (none skipped because `E2E_DATABASE_URL` was set), build succeeds.

- [ ] **Step 4: Commit**

```bash
git add README.md TODO.md
git commit -m "Document the approval policy and audit log; tick TODO 4.2 and 4.3

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
