# More tools: `track_shipment` and `cancel_order` (4.6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `track_shipment` tool and a risky `cancel_order` tool (always human-approved, audit-logged), and make the mock provider, the reviewer console and the customer chat handle both.

**Architecture:** A new `shipments` table and an `orders.cancel_action_id` column (idempotent DDL). `ShopRepo` gains `getShipment` and an atomic `cancelOrder` (row lock, replay-safe by action id) mirroring `createRefund`. Two new `ToolDef`s use the existing `loadOwnedOrder` / `preflight` / `risky` machinery; `evaluateApproval` gets a `cancel_order` branch returning `human` with a new rule `tool_requires_review`. The web `ApprovalsPanel` / `AuditLog` become tool-aware.

**Tech Stack:** NestJS 11, `pg`, Ajv tool schemas, Jest (API), `node:test` through `tsx` (web), Next.js 16.

**Spec:** `docs/superpowers/specs/2026-10-28-more-tools-design.md`

## Global Constraints

- The model never supplies a customer id; tools act on the conversation's bound customer (`ctx.customerId`). Another customer's order → `GuardrailViolation('CROSS_CUSTOMER')` for both new tools.
- `cancel_order` succeeds only for a `processing` order with **zero** refunds. Guardrail codes (exact): `ALREADY_CANCELLED` (status `cancelled`), `NOT_CANCELLABLE` (`shipped` or `delivered`), `HAS_REFUNDS` (refunds sum > 0), checked in that order. Add all three to `GuardrailCode`.
- `cancel_order` always goes to a human: `evaluateApproval('cancel_order', …)` returns exactly `{ mode: 'human', rule: 'tool_requires_review', detail: {} }` regardless of `REFUND_AUTO_APPROVE_UNDER`. Unknown risky tools still return rule `default`. `REFUND_AUTO_APPROVE_UNDER` semantics are unchanged.
- `PgShopRepo.cancelOrder` runs in one transaction with `SELECT … FOR UPDATE` on the order row (the same lock `createRefund` takes), so a cancel and a refund on one order serialise. A replay with the same `actionId` (`orders.cancel_action_id = actionId`) returns `{ orderId, status: 'cancelled' }` without error.
- `orders.cancel_action_id` and any other internal column are never returned to the model or the API: order queries select explicit columns `id, customer_id, status, total, items, created_at`.
- The model-facing prompt and tool descriptions must not mention any threshold value, and must not claim a cancellation is immediate: cancellations queue for a human reviewer.
- Customers never see policy details (existing `approvalForCaller` stripping stays); a new `orderStatus` field on approvals is reviewer-only like the rest of `GET /approvals`. **Ruling:** customers also receive `orderStatus` for their own orders (deviation accepted; ownership is enforced by the preflight check, so it is never another customer's order).
- E2E tests run ONLY against the localhost:5435 `aiagent_test` database: `E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5435/aiagent_test`. They re-seed it. Never touch other ports or other projects' containers.
- `next build` prints a SecurityFatalError about a Next.js 16.4.0 advisory on its first run; an immediate retry passes. Do not run `next upgrade`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Match surrounding code style: comment density, naming, 2-space indent, single quotes.

## Review Focus

1. A cancel and a refund racing on the same order must never leave a cancelled order with a refund, or a refund recorded after a cancel (Task 1 e2e).
2. Replaying an approved cancel (crash recovery, retry after a lost reply) must neither fail nor cancel twice (Task 1 e2e, Task 5).
3. A customer must not be able to cancel or track another customer's order, and must not learn that order exists beyond the existing `CROSS_CUSTOMER` message (Tasks 2 and 5).
4. A rejected or expired cancel must leave the order exactly as it was and tell the model not to retry (Tasks 2 and 5).
5. The reviewer must be able to tell a cancel card from a refund card and see why it needs review; refund cards must not regress (Task 4).

---

### Task 1: Data layer — schema, seed, guardrail, `ShopRepo`

**Files:**
- Modify: `apps/api/src/agent/errors.ts` (3 codes)
- Modify: `apps/api/src/agent/types.ts` (`Shipment`, `ShipmentEvent`, `ShopRepo` additions)
- Modify: `apps/api/src/agent/guardrails.ts`, `apps/api/src/agent/guardrails.spec.ts`
- Modify: `apps/api/src/db/schema.ts` (DDL + `RESET_SQL`), `apps/api/src/db/seed-data.ts`, `apps/api/src/db/pg-shop.repo.ts`
- Modify: `apps/api/test/fakes.ts` (`MemoryShop`)
- Create: `apps/api/test/shop-cancel.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `ShipmentEvent { at: string; location: string; description: string }`
  - `Shipment { orderId: number; carrier: string; trackingNumber: string; status: 'label_created' | 'in_transit' | 'out_for_delivery' | 'delivered'; eta: string | null; events: ShipmentEvent[] }`
  - `ShopRepo.getShipment(orderId: number): Promise<Shipment | null>`
  - `ShopRepo.cancelOrder(input: { customerId: number; orderId: number; actionId?: string }): Promise<{ orderId: number; status: 'cancelled' }>`
  - `assertCancellable(check: { status: OrderStatus; priorRefunded: number }): void` in `guardrails.ts`
  - `GuardrailCode` gains `'NOT_CANCELLABLE' | 'ALREADY_CANCELLED' | 'HAS_REFUNDS'`
- Consumes: existing `GuardrailViolation`, `assertSameCustomer`, `createRefund`'s locking pattern.

- [ ] **Step 1: Write the failing guardrail tests**

Append to `apps/api/src/agent/guardrails.spec.ts` (imports `assertCancellable` too):

```ts
describe('assertCancellable', () => {
  it('allows a processing order with no refunds', () => {
    expect(code(() => assertCancellable({ status: 'processing', priorRefunded: 0 }))).toBeUndefined();
  });
  it('refuses a cancelled order first, then shipped or delivered ones, then refunded ones', () => {
    expect(code(() => assertCancellable({ status: 'cancelled', priorRefunded: 5 }))).toBe('ALREADY_CANCELLED');
    expect(code(() => assertCancellable({ status: 'shipped', priorRefunded: 0 }))).toBe('NOT_CANCELLABLE');
    expect(code(() => assertCancellable({ status: 'delivered', priorRefunded: 5 }))).toBe('NOT_CANCELLABLE');
    expect(code(() => assertCancellable({ status: 'processing', priorRefunded: 0.01 }))).toBe('HAS_REFUNDS');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/api && npx jest src/agent/guardrails.spec.ts` → FAIL (`assertCancellable` missing).

- [ ] **Step 3: Implement the codes, types and guardrail**

`errors.ts`: add `| 'NOT_CANCELLABLE' | 'ALREADY_CANCELLED' | 'HAS_REFUNDS'` to `GuardrailCode`.

`types.ts`: add the `ShipmentEvent` / `Shipment` interfaces above and the two `ShopRepo` methods (with doc comments: `cancelOrder` "Atomically re-checks that the order can still be cancelled, then cancels it; a replay of the same actionId returns the same result").

`guardrails.ts` (uses the existing `toCents`):

```ts
export interface CancelCheck {
  status: OrderStatus;
  priorRefunded: number;
}

/** Only a processing order with no money refunded can still be cancelled. */
export function assertCancellable({ status, priorRefunded }: CancelCheck): void {
  if (status === 'cancelled') throw new GuardrailViolation('ALREADY_CANCELLED', 'This order is already cancelled.');
  if (status !== 'processing') {
    throw new GuardrailViolation(
      'NOT_CANCELLABLE',
      `This order is ${status} and can no longer be cancelled; a refund or a support ticket is the way to resolve it.`,
    );
  }
  if (toCents(priorRefunded) > 0) {
    throw new GuardrailViolation('HAS_REFUNDS', 'This order has refunds recorded against it, so it cannot be cancelled.');
  }
}
```

- [ ] **Step 4: Schema, seed and `PgShopRepo`**

`schema.ts` — append to the DDL (before the closing backtick), and add `shipments` to `RESET_SQL`:

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_action_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS orders_cancel_action_uniq ON orders (cancel_action_id) WHERE cancel_action_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS shipments (
  order_id int PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  carrier text NOT NULL,
  tracking_number text NOT NULL,
  status text NOT NULL CHECK (status IN ('label_created', 'in_transit', 'out_for_delivery', 'delivered')),
  eta timestamptz,
  events jsonb NOT NULL DEFAULT '[]'
);
```

`seed-data.ts`: inside the order loop, after each order insert, for `shipped` and `delivered` orders insert a deterministic shipment: carrier `['UPS','FedEx','DHL','USPS'][n % 4]`, a tracking number derived from `n` (for example `` `${prefix}${900000000 + n * 7919}` ``), status `delivered` for delivered orders and `in_transit` / `out_for_delivery` alternating by `n % 2` for shipped ones, an ETA (delivered: the delivery time; shipped: 1-3 days from now), and a list of 3-4 events with ISO timestamps, locations and descriptions ("Label created", "Picked up by carrier", "In transit", "Delivered" for delivered orders). Keep it deterministic apart from the clock-relative timestamps. No shipment for `processing` / `cancelled` orders.

`pg-shop.repo.ts`:
- Replace the two `SELECT * FROM orders` queries with an explicit column list (`const ORDER_COLUMNS = 'id, customer_id, status, total, items, created_at'`), so `cancel_action_id` never reaches the model.
- Add:

```ts
  async getShipment(orderId: number): Promise<Shipment | null> {
    const { rows } = await this.pool.query('SELECT * FROM shipments WHERE order_id = $1', [orderId]);
    return rows[0] ? camel<Shipment>(rows[0]) : null;
  }

  async cancelOrder(input: { customerId: number; orderId: number; actionId?: string }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The same row lock createRefund takes: a cancel and a refund on one order cannot interleave.
      const o = await client.query('SELECT customer_id, status, cancel_action_id FROM orders WHERE id = $1 FOR UPDATE', [input.orderId]);
      if (!o.rows[0]) throw new GuardrailViolation('NOT_FOUND', `Order #${input.orderId} was not found.`);
      assertSameCustomer(input.customerId, o.rows[0].customer_id, `Order #${input.orderId}`);
      if (input.actionId && o.rows[0].cancel_action_id === input.actionId) {
        // Replay of an approval whose cancellation already committed: report it again, never fail or cancel twice.
        await client.query('COMMIT');
        return { orderId: input.orderId, status: 'cancelled' as const };
      }
      const refunded = await client.query('SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE order_id = $1', [input.orderId]);
      assertCancellable({ status: o.rows[0].status, priorRefunded: refunded.rows[0].total });
      await client.query("UPDATE orders SET status = 'cancelled', cancel_action_id = $2 WHERE id = $1", [input.orderId, input.actionId ?? null]);
      await client.query('COMMIT');
      return { orderId: input.orderId, status: 'cancelled' as const };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
```

(import `assertCancellable`, `Shipment`.)

- [ ] **Step 5: `MemoryShop`** (`apps/api/test/fakes.ts`)

Give `MemoryShop` its own mutable copy of the orders (`orders: Order[] = ORDERS.map((o) => ({ ...o }))`), have `listOrders` / `getOrder` read it, add `shipments: Shipment[]` (seed two: one `in_transit` for order 2 and one `delivered` for order 1, with a few events), `getShipment`, and `cancelOrder` mirroring the Pg behaviour using `assertSameCustomer`, a `cancelActions = new Map<number, string>()` for the replay check, and `assertCancellable` against `totalRefunded`. Existing tests must keep passing unchanged (the module-level `ORDERS` is no longer mutated).

- [ ] **Step 6: E2E store tests**

Create `apps/api/test/shop-cancel.e2e-spec.ts` (skipped without `E2E_DATABASE_URL`; setup pattern from `audit-log.e2e-spec.ts`: boot `AppModule`, `seedDatabase(pool)`, get `PgShopRepo`). Seeded facts: order N belongs to customer `((N-1) % 10) + 1`; statuses cycle by `N % 7` over `['delivered','delivered','shipped','delivered','processing','delivered','cancelled']`, so order 11 (customer 1) is `processing`, order 2 (customer 2) is `shipped`, order 1 (customer 1) is `delivered`, order 6 (customer 6) is `cancelled`; order 12 has a prior refund and is not processing, so create the "processing but refunded" case by inserting a refund row on order 11 inside that test. Cases:
1. `cancelOrder` cancels order 11 for customer 1 and `getOrder(11).status === 'cancelled'`; `getOrder` result has no `cancelActionId` key.
2. Replay: the same `actionId` (a fresh uuid) a second time returns the same result and does not throw.
3. Refusals with the right codes: shipped order 2 (`NOT_CANCELLABLE`, called by its owner customer 2), delivered order 1, already-cancelled order (cancel 11 twice with *different* action ids → `ALREADY_CANCELLED`), a processing order with a refund row (`HAS_REFUNDS`), another customer's order (`CROSS_CUSTOMER`), unknown id (`NOT_FOUND`). Assert nothing changed after each refusal.
4. Race: for a fresh processing order, start `cancelOrder` and `createRefund` concurrently (`Promise.allSettled`), repeat for a few orders/iterations; afterwards the order is never both `cancelled` with a refund row, and exactly one of the two succeeded.
5. `getShipment`: returns carrier, tracking number, status, ISO `eta` and an events array for every seeded `shipped` / `delivered` order, and `null` for `processing` and `cancelled` orders (iterate all 30 orders).

- [ ] **Step 7: Run everything**

Run: `cd apps/api && npx jest src/agent/guardrails.spec.ts && E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5435/aiagent_test npx jest && npm run typecheck -w apps/api`
Expected: all pass (existing 292 plus the new ones), typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add apps/api
git commit -m "Add shipments, cancel_order data layer and cancellation guardrail

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Policy, tools and prompt

**Files:**
- Modify: `apps/api/src/agent/policy.ts`, `apps/api/src/agent/policy.spec.ts`
- Modify: `apps/api/src/agent/tools.ts`, `apps/api/src/agent/tools.spec.ts`
- Modify: `apps/api/src/agent/prompt.ts`
- Modify: `apps/api/src/agent/runner.spec.ts`, `apps/api/src/agent/guardrails.spec.ts` (tool-level cases)

**Interfaces:**
- Consumes: Task 1's `assertCancellable`, `ShopRepo.getShipment`, `ShopRepo.cancelOrder`, `MemoryShop` additions.
- Produces: tools `track_shipment` and `cancel_order` in `TOOLS`; `ApprovalRule` gains `'tool_requires_review'`.

- [ ] **Step 1: Write the failing tests**

`policy.spec.ts`: the existing test "sends an unknown risky tool to a human" uses `cancel_order` as its example; change that example to `'delete_everything'` and add:

```ts
describe('evaluateApproval for cancel_order', () => {
  it('always goes to a human, whatever the refund threshold', () => {
    for (const threshold of [0, 25, 1_000_000]) {
      expect(evaluateApproval('cancel_order', { orderId: 1, reason: 'changed my mind' }, {}, cfg(threshold))).toEqual({
        mode: 'human', rule: 'tool_requires_review', detail: {},
      });
    }
  });
});
```

`tools.spec.ts`: add valid args `track_shipment: { orderId: 7 }` and `cancel_order: { orderId: 7, reason: 'Ordered by mistake' }` to the "accepts valid arguments for every tool" map; add invalid cases `['track_shipment', {}]`, `['track_shipment', { orderId: 0 }]`, `['track_shipment', { orderId: 1, customerId: 1 }]`, `['cancel_order', { orderId: 1 }]`, `['cancel_order', { orderId: 1, reason: 'no' }]`, `['cancel_order', { orderId: 1, reason: 'because', extra: true }]`, `['cancel_order', { orderId: 2 ** 31, reason: 'because' }]`.

Tool-level cases (in `guardrails.spec.ts`'s tool-level describe, conversation bound to customer 1, `MemoryShop`): `track_shipment` on own delivered order returns `{ shipped: true, carrier, trackingNumber, status: 'delivered', ... }`; on order 2 (customer 2's) throws `CROSS_CUSTOMER`; on a processing order (push one into `shop.orders`) returns `{ shipped: false, orderStatus: 'processing' }`. `cancel_order.preflight` on a processing own order resolves; on a delivered one rejects `NOT_CANCELLABLE`; on order 3 (cancelled) `ALREADY_CANCELLED`; with a refund recorded `HAS_REFUNDS`; on another customer's order `CROSS_CUSTOMER`. `cancel_order.execute` cancels and returns `{ orderId, status: 'cancelled' }`.

`runner.spec.ts` (use the file's module-level `scripted` helper and `MemoryShop`/`MemoryStore`; push a processing order for customer 1 into `shop.orders`): (a) scripted `cancel_order` parks as `pending_approval` (run `awaiting_approval`), the store has a `requested` event with `rule: 'tool_requires_review'`, and the order is still `processing`; (b) `runner.decide(id, 'approve')` cancels the order and the run completes; (c) `decide(id, 'reject')` leaves the order untouched and the tool result tells the model not to retry; (d) with `approvalPolicy: { refundAutoApproveUnder: 1_000_000 }` a cancel STILL parks and no `auto_approved` event exists; (e) a scripted cancel of another customer's order yields a `CROSS_CUSTOMER` tool result, no action, no events.

- [ ] **Step 2: Run to verify they fail** — `cd apps/api && npx jest src/agent` → FAIL.

- [ ] **Step 3: Implement**

`policy.ts`: add `'tool_requires_review'` to `ApprovalRule`, and in `evaluateApproval`:

```ts
  if (toolName === 'cancel_order') return human('tool_requires_review');
```

`tools.ts`: import `assertCancellable`; add after `issue_refund`:

```ts
  {
    name: 'track_shipment',
    description:
      "Get the shipment status of one of this customer's orders: carrier, tracking number, status, ETA and recent events. " +
      'An order that has not shipped yet has no shipment.',
    inputSchema: { type: 'object', properties: { orderId: id }, required: ['orderId'], additionalProperties: false },
    async execute(ctx, { orderId }: { orderId: number }) {
      const order = await loadOwnedOrder(ctx, orderId);
      const shipment = await ctx.shop.getShipment(orderId);
      if (!shipment) return { shipped: false, orderId, orderStatus: order.status };
      const { carrier, trackingNumber, status, eta, events } = shipment;
      return { shipped: true, orderId, carrier, trackingNumber, status, eta, events };
    },
  },
  {
    name: 'cancel_order',
    description:
      'Request cancellation of an order that has not shipped yet and has no refunds. RISKY: cancellations are queued for a human reviewer; ' +
      'the result says whether the order was cancelled or the request was declined.',
    risky: true,
    inputSchema: {
      type: 'object',
      properties: { orderId: id, reason: { type: 'string', minLength: 3, maxLength: 300 } },
      required: ['orderId', 'reason'],
      additionalProperties: false,
    },
    async preflight(ctx, { orderId }: { orderId: number }) {
      const order = await loadOwnedOrder(ctx, orderId);
      assertCancellable({ status: order.status, priorRefunded: await ctx.shop.totalRefunded(orderId) });
      return {};
    },
    async execute(ctx, args: { orderId: number; reason: string; actionId?: string }) {
      // cancelOrder re-runs ownership and cancellability checks inside a row-locking transaction.
      return ctx.shop.cancelOrder({ customerId: ctx.customerId, orderId: args.orderId, actionId: args.actionId });
    },
  },
```

Check in `runner.ts` how `actionId` reaches `execute` for `issue_refund` and make sure `cancel_order` receives it the same way (do not hard-code a tool name there).

`prompt.ts`: after the `issue_refund` line add: `'cancel_order queues the cancellation for a human reviewer and works only for orders that are still being processed; use track_shipment for delivery questions.'` (no thresholds).

- [ ] **Step 4: Run to verify they pass** — `cd apps/api && npx jest src` then the full suite with `E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5435/aiagent_test npx jest` and `npm run typecheck -w apps/api`. `prompt.spec` (stability of `promptVersion`) must still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "Add track_shipment and cancel_order tools with a human-review policy rule

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Mock provider intents

**Files:**
- Modify: `apps/api/src/providers/mock.provider.ts`
- Modify: `apps/api/src/providers/providers.spec.ts` (MockProvider describe) and/or `apps/api/src/agent/runner.spec.ts`

**Interfaces:** Consumes the two tools from Task 2 (by name and result shape: `track_shipment` → `{ shipped, orderId, carrier, trackingNumber, status, eta, events }` or `{ shipped:false, orderId, orderStatus }`; `cancel_order` → `{ status: 'cancelled', orderId }` or, after a rejection, `{ status: 'rejected', message }`).

- [ ] **Step 1: Write failing tests** (deterministic scripted flows through `AgentRunner` + `MemoryShop`/`MemoryStore`, as the existing runner mock-flow tests do):
1. "Cancel order #N, I ordered it by mistake" (N a processing order of the bound customer): calls `get_order` then `cancel_order` (`{ orderId: N, reason: <the text, ≤300 chars> }`), the run pauses; after `decide approve` the final assistant text says the order was cancelled.
2. Same, rejected: the final text says a reviewer declined it (and includes the reviewer note when present).
3. "Cancel my order" (no id): calls `list_orders` and asks which order.
4. "Cancel order #N" on a delivered order: `cancel_order` is never parked; the final text contains the guardrail message ("I wasn't able to do that: …").
5. "Where is my order #N?" / "track order #N": calls `track_shipment` and the answer contains the carrier, tracking number and status; for a not-yet-shipped order it says the order has not shipped yet and its status.
6. A message mentioning both refund and cancel still takes the refund path (existing priority).
7. The existing mock flows (refund, ticket, orders, order lookup, email, greeting) are unchanged.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: Implement** in `mock.provider.ts`:
- Add `const WANTS_CANCEL = /\bcancel/i;` and `const WANTS_TRACK = /\b(track|tracking|shipment|where(?:'s| is)(?: my)?(?: order| package| parcel)|has (?:it|my order) shipped|delivery status)/i;`.
- After the refund block and before the ticket block: the cancel flow (no `orderId` → `list_orders` then ask "Which order would you like to cancel? …"; else `get_order` then `cancel_order` with a thought that mentions it will be reviewed, then the final text: `r.status === 'cancelled'` → `Order #N has been cancelled.`; otherwise `A reviewer declined the cancellation of order #N. ${r.message ?? ''}`).
- The track flow (no `orderId` → list orders and ask; else `track_shipment`, then summarise: shipped → `Order #N shipped with <carrier> (tracking <trackingNumber>): <status>, ETA <date>. Latest: <last event description> (<location>).`; not shipped → `Order #N has not shipped yet (it is <orderStatus>).`). Put the track flow before the generic `if (orderId)` lookup.
- Update the greeting to mention cancelling and tracking.

- [ ] **Step 4: Run** `cd apps/api && npx jest src && npm run typecheck -w apps/api` → pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "Teach the mock provider to cancel orders and track shipments

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Reviewer console and chat copy

**Files:**
- Modify: `apps/api/src/db/pg-agent.store.ts` (`listApprovals`: add `o.status AS order_status`; `ApprovalView.orderStatus: string | null`); check `apps/api/src/http/run-view.ts` (`approvalForCaller`) so the new field does not widen what customers can see beyond what they already see about their own order.
- Modify: `apps/web/src/lib/types.ts` (`Approval.orderStatus?: string | null`), `apps/web/src/lib/policy.ts`, `apps/web/src/components/ApprovalsPanel.tsx`, `apps/web/src/components/AuditLog.tsx`, `apps/web/src/components/Chat.tsx`, `apps/web/src/app/globals.css` (only if needed)
- Create: `apps/web/src/lib/policy.test.ts`

**Interfaces:** Consumes the `tool_requires_review` rule and `cancel_order` actions from Task 2.

- [ ] **Step 1: Write the failing web test** `apps/web/src/lib/policy.test.ts` (`node:test`, relative imports): `describeRule('tool_requires_review', {})` → `'This kind of action always needs review'`; the three existing refund rules keep their exact current wording (`always_review` → `'Every refund needs review'`; `over_threshold` with full detail → text containing the cumulative total and the limit; `under_threshold`); unknown / null rule → `null`.

- [ ] **Step 2: Implement**
- `policy.ts`: add the `tool_requires_review` case.
- `ApprovalsPanel.tsx`: make `Card` tool-aware. For `a.toolName === 'cancel_order'`: title `Cancel order · #<orderId>`, no amount block, a dl with Order status (`a.orderStatus`), Order total, Already refunded; the reason line stays. For refunds nothing changes (same title, amount, dl). Unknown tool names render a generic title (`a.toolName` · order #… if present). Update the empty-state text to "Nothing waiting. Ask the agent to refund or cancel an order to see one here."
- `AuditLog.tsx`: title `Cancel · order #N` for `cancel_order` (no amount); refunds unchanged.
- `Chat.tsx`: change "larger refunds wait for a human" to "refunds and cancellations may wait for a human" (do not hint at any limit); "⏸ A refund is waiting for human approval." → "⏸ A request is waiting for human approval."; the suggestion chips may stay.
- `pg-agent.store.ts`: add `o.status AS order_status` to the `listApprovals` query and `orderStatus: string | null` to `ApprovalView`.

- [ ] **Step 3: Verify** — `cd apps/web && npm test` (web tests incl. the new file), `npm run typecheck`, `E2E_DATABASE_URL=… npx jest` for the API (a store assertion on `orderStatus` can be added to an existing approvals e2e test), `npm run build -w apps/web` (retry once on the known first-run error). No component-test setup exists; state in the report whether you drove the UI in a browser (do not start docker containers; if you cannot, say so).

- [ ] **Step 4: Commit**

```bash
git add apps
git commit -m "Show cancellation requests in the reviewer console and audit log

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: HTTP end-to-end tests

**Files:**
- Create: `apps/api/test/cancel-track.e2e-spec.ts`

**Interfaces:** Consumes everything above. Follow `apps/api/test/approval-flow.e2e-spec.ts` (boot `AppModule`, `configureApp(app)`, `seedDatabase`, supertest; env `LLM_PROVIDER=mock`, `MOCK_DELAY_MS=0`; `REVIEWER_API_KEY` unset unless a case needs it). Seeded facts: order N belongs to customer `((N-1)%10)+1`, so customer 1 owns orders 1 (delivered), 11 (processing) and 21 (delivered); order 2 (customer 2) is shipped; order 6 (customer 6) is cancelled; order 12 has a prior refund.

- [ ] **Step 1: Write the tests** (each its own `it`):
1. Cancel → approve: customer 1 sends "Cancel order #11, I ordered it by mistake"; the run is `awaiting_approval`; `GET /approvals` shows a pending `cancel_order` action with `orderStatus: 'processing'`; approve via `POST /approvals/:id`; the order row is `cancelled` with `cancel_action_id` set; the run completes and the final assistant message says it was cancelled; the audit log (`GET /approvals/events?conversationId=…`) has `requested` (rule `tool_requires_review`) and `approved`; no `auto_approved` even when `REFUND_AUTO_APPROVE_UNDER=1000000` is set (a second describe/it with that env).
2. Cancel → reject with a note: order 11 stays `processing`; the final message says a reviewer declined; events `requested` + `rejected`.
3. Guardrails over HTTP: "Cancel order #1" (delivered) and "Cancel order #6"-style cases answer with the guardrail message and create NO pending action; another customer's order (customer 1 asking for order #2) is `CROSS_CUSTOMER` and creates no action.
4. After order 11 is cancelled, "Refund order #11" is rejected by the existing `ORDER_CANCELLED` guardrail (no pending refund).
5. Replay: take an approved cancel's `action_id` from `orders.cancel_action_id`, call `PgShopRepo.cancelOrder` again with it, assert no error and unchanged order (and, via the HTTP API, a second `POST /approvals/:id` on the decided action returns 409 as today).
6. `track_shipment` over HTTP: customer 2 asking "Where is my order #2?" gets an answer with the seeded carrier and tracking number; customer 1 asking about delivered order #1 gets `delivered`; customer 1 asking about processing order #11 gets "has not shipped yet"; customer 1 asking about order #2 gets the cross-customer refusal text and no data from the shipment (assert the response never contains order 2's tracking number).
7. Customer privacy: `GET /conversations/:id` with the customer's token for a conversation with a parked cancel shows the action but no `policyRule` / `policyDetail`.

- [ ] **Step 2: Run** `cd apps/api && E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5435/aiagent_test npx jest test/cancel-track.e2e-spec.ts` (3 times in a row for flakiness), then the full suite and typecheck.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test
git commit -m "Cover cancel_order and track_shipment end to end

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Docs, TODO and final verification

**Files:** `README.md`, `TODO.md`

- [ ] **Step 1: README** — tools list: add `track_shipment` and `cancel_order` (risky, always reviewed, only `processing` orders with no refunds); the approval policy section: cancellations always go to a human with rule `tool_requires_review` and are unaffected by `REFUND_AUTO_APPROVE_UNDER`; the `GET /approvals` row gains `orderStatus`; security notes: ownership checks on both new tools, the cancel/refund row lock, replay safety; the demo prompts ("Cancel order #11, I ordered it by mistake", "Where is my order #2?"); the seeded shipments. Keep the README's voice; mention only facts you verified in the code.
- [ ] **Step 2: TODO.md** — tick `4.6`.
- [ ] **Step 3: Verify** from the repo root: `npm run typecheck`; `E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5435/aiagent_test npm test`; `npm run build` (retry once on the first-run SecurityFatalError; do not run `next upgrade`). Report real counts. State that no browser check was run unless you ran one.
- [ ] **Step 4: Commit**

```bash
git add README.md TODO.md
git commit -m "Document the new tools; tick TODO 4.6

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
