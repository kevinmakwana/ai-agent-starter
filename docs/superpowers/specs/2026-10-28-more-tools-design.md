# More tools: `track_shipment` and `cancel_order` (TODO 4.6)

## Goal

Give the support agent two more tools: `track_shipment` (read-only) and `cancel_order` (risky: it always waits for a
human reviewer and is recorded in the audit log). The mock provider, the reviewer console and the customer chat must
handle both end to end.

Success criteria:

- A customer can ask where an order is and gets the carrier, tracking number, status, ETA and latest events.
- A customer can ask to cancel an order; the request parks for a reviewer, who approves or rejects it, and the decision
  is audit-logged like any other.
- Only the bound customer's orders can be tracked or cancelled; the model never supplies a customer id.
- A cancellation can never succeed on an order that is shipped, delivered, already cancelled, or has any refund, and an
  approval replayed after a crash never cancels twice or fails.
- The existing approval policy semantics (`REFUND_AUTO_APPROVE_UNDER`) are unchanged.

## Decisions made

| Question | Decision |
|---|---|
| Which orders can be cancelled | `processing` only, with no refunds recorded. Shipped and delivered orders use a refund or a ticket instead. |
| Approval for cancellation | Always a human. No auto-approve setting. Audit rule `tool_requires_review`. |
| Tracking data | A real `shipments` table, seeded for every `shipped` and `delivered` order. |
| Refund interplay | A cancel needs zero refunds; a refund on a cancelled order is already rejected (`ORDER_CANCELLED`), including one approved after the cancel. |

## 1. Data

- `shipments(order_id int PRIMARY KEY REFERENCES orders ON DELETE CASCADE, carrier text, tracking_number text, status text CHECK IN ('label_created','in_transit','out_for_delivery','delivered'), eta timestamptz, events jsonb)`; `events` is a list of `{ at, location, description }`. Created by the same idempotent DDL as the rest of the schema; added to `RESET_SQL`.
- `orders.cancel_action_id uuid` (added with `ALTER TABLE … ADD COLUMN IF NOT EXISTS`), unique where not null, records which approved action cancelled the order so a replay can recognise its own work. It is not exposed to the model or the API (order queries select explicit columns).
- Seed: deterministic carriers, tracking numbers, statuses and events for each shipped / delivered order; none for processing / cancelled orders.

## 2. Tools

- `track_shipment { orderId }`: loads the order with the same ownership check as `get_order` (another customer's order → `CROSS_CUSTOMER`). Returns `{ shipped: true, orderId, carrier, trackingNumber, status, eta, events }`, or `{ shipped: false, orderId, orderStatus }` when the order has no shipment (not an error).
- `cancel_order { orderId, reason }` (`reason`: 3–300 characters), `risky: true`.
  - `preflight`: ownership, then `assertCancellable({ status, priorRefunded })`: `ALREADY_CANCELLED` for a cancelled order, `NOT_CANCELLABLE` for shipped / delivered, `HAS_REFUNDS` when `priorRefunded > 0`. Returns no approval facts.
  - `execute`: `shop.cancelOrder({ customerId, orderId, actionId })`, one transaction under `SELECT … FOR UPDATE` on the order: ownership, replay check (`cancel_action_id = actionId` → return the same success), `assertCancellable` against the refunds sum, then `UPDATE orders SET status='cancelled', cancel_action_id=…`. Returns `{ status: 'cancelled', orderId }`.
- Approval policy: `evaluateApproval('cancel_order', …)` returns `{ mode: 'human', rule: 'tool_requires_review', detail: {} }`. Other unknown risky tools still fail closed with rule `default`. The tool description and system prompt say cancellations queue for review and never mention a threshold.
- New guardrail codes: `NOT_CANCELLABLE`, `ALREADY_CANCELLED`, `HAS_REFUNDS`.

## 3. Mock provider and UI

- Mock provider: "cancel order #N" → `get_order`, `cancel_order`, final message (cancelled, or the reviewer's rejection); "where is / track … order #N" → `track_shipment` and a one-paragraph summary. "Cancel" without an order id lists orders first. Refund intent keeps priority when a message mentions both.
- Reviewer console: `ApprovalsPanel` becomes tool-aware (a "Cancel order #N" card with the reason and the order's status and total; no amount; refund cards unchanged). `GET /approvals` rows gain `orderStatus`. `AuditLog` titles cancellations "Cancel · order #N". `describeRule('tool_requires_review')` → "This kind of action always needs review". The audit-log and chat copy that says "refund" generically is made tool-neutral where it would be wrong.

## 4. Testing

- Unit: `assertCancellable` cases; policy rule and the unknown-tool fail-closed case (the existing test that uses `cancel_order` as its unknown tool changes to another name); tool schemas; ownership; the not-shipped tracking result; runner: a cancel parks, approve executes and cancels, reject leaves the order untouched, another customer's order is blocked, no audit `auto_approved` for cancels even with a refund threshold set; mock provider intents; web `describeRule` (node:test).
- E2E (port 5435 only): `PgShopRepo.cancelOrder` (success, replay by the same action id, shipped / refunded / cancelled / cross-customer refusals, a refund racing a cancel); over HTTP: cancel → approve → order cancelled, audit events present, cancel → reject, a refund on the cancelled order is rejected; `track_shipment` for shipped, delivered, processing and foreign orders.

## 5. Docs

README tools list and policy / security notes; TODO 4.6 ticked.

## Out of scope

Partial cancellation, restocking, real carrier APIs, address changes, an auto-approve rule for cancellations.
