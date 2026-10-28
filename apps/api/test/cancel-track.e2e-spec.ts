import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PgShopRepo } from '../src/db/pg-shop.repo';
import { seedDatabase } from '../src/db/seed-data';
import { configureApp } from '../src/http/setup';
import { PG_POOL } from '../src/tokens';

// Runs against a real Postgres; skipped unless E2E_DATABASE_URL is set (CI sets it).
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

// Seeded: order N belongs to customer ((N-1) % 10) + 1, so customer 1 owns orders 1 (delivered), 11 (processing), 21 (delivered).
// Order 2 (customer 2) is shipped, order 6 (customer 6) is cancelled, order 12 (customer 2) has a prior $10 refund.
const CANCEL_11 = 'Cancel order #11, I ordered it by mistake';
// order 2 ships with carrier index 2 % 4 = DHL and tracking number JD + (900000000 + 2 * 7919)
const ORDER_2_TRACKING = 'JD900015838';

const seq = (steps: any[]) => steps.map((s) => `${s.role}:${s.toolName ?? ''}`);
const toolResults = (steps: any[], name: string) => steps.filter((s) => s.role === 'tool' && s.toolName === name).map((s) => s.result);

maybe('cancel_order and track_shipment (e2e, real Postgres)', () => {
  let app: INestApplication;
  let pool: Pool;
  const http = () => request(app.getHttpServer());

  const boot = async () => {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    configureApp(app);
    await app.init();
    pool = app.get(PG_POOL);
    await seedDatabase(pool);
  };

  const newConversation = async (customerId: number) =>
    (await http().post('/conversations').send({ customerId }).expect(201)).body.id as string;

  const say = async (id: string, content: string) =>
    (await http().post(`/conversations/${id}/messages`).send({ content }).expect(201)).body.run;

  const pending = async () => (await http().get('/approvals?status=pending').expect(200)).body as any[];
  const events = async (conversationId: string) =>
    ((await http().get(`/approvals/events?conversationId=${conversationId}`).expect(200)).body as any[]).reverse(); // oldest first
  const order = async (id: number) => (await pool.query('SELECT status, cancel_action_id FROM orders WHERE id = $1', [id])).rows[0];

  afterEach(async () => {
    delete process.env.REFUND_AUTO_APPROVE_UNDER;
    delete process.env.REVIEWER_API_KEY;
    await app?.close();
  });

  describe('cancelling an order', () => {
    beforeEach(() => boot());

    it('parks the request, and approving it cancels the order and tells the customer', async () => {
      const id = await newConversation(1);
      const run = await say(id, CANCEL_11);
      expect(run.status).toBe('awaiting_approval');
      expect(seq(run.steps)).toEqual(['user:', 'assistant:get_order', 'tool:get_order', 'assistant:cancel_order']);
      expect(await order(11)).toEqual({ status: 'processing', cancel_action_id: null }); // nothing happens before approval

      const [approval, ...rest] = await pending();
      expect(rest).toHaveLength(0);
      expect(approval).toMatchObject({
        toolName: 'cancel_order', status: 'pending_approval', conversationId: id, customerEmail: 'ava.brooks@example.com',
        toolArgs: { orderId: 11, reason: CANCEL_11 }, orderStatus: 'processing', policyRule: 'tool_requires_review',
      });

      const decided = await http().post(`/approvals/${approval.id}`).send({ decision: 'approve', note: 'ok' }).expect(201);
      expect(decided.body.action.status).toBe('approved');
      expect(decided.body.run.status).toBe('completed');
      expect(seq(decided.body.run.steps)).toEqual([
        'user:', 'assistant:get_order', 'tool:get_order', 'assistant:cancel_order', 'tool:cancel_order', 'assistant:',
      ]);
      expect(toolResults(decided.body.run.steps, 'cancel_order')).toEqual([{ orderId: 11, status: 'cancelled' }]);
      expect(decided.body.run.steps.at(-1).content).toBe('Order #11 has been cancelled.');

      expect(await order(11)).toEqual({ status: 'cancelled', cancel_action_id: approval.id });
      // only order 11 changed: 6, 13, 20 and 27 were already cancelled by the seed
      const { rows } = await pool.query("SELECT id FROM orders WHERE status = 'cancelled' ORDER BY id");
      expect(rows.map((r) => r.id)).toEqual([6, 11, 13, 20, 27]);
      expect(await pending()).toHaveLength(0);

      const log = await events(id);
      expect(log.map((e) => e.kind)).toEqual(['requested', 'approved']);
      expect(log[0]).toMatchObject({ actionId: approval.id, toolName: 'cancel_order', actorType: 'policy', rule: 'tool_requires_review' });
      expect(log[1]).toMatchObject({ actionId: approval.id, toolName: 'cancel_order', actorType: 'reviewer', note: 'ok' });
    });

    it('a rejected request leaves the order alone and tells the customer a reviewer declined', async () => {
      const id = await newConversation(1);
      await say(id, CANCEL_11);
      const [approval] = await pending();

      const res = await http().post(`/approvals/${approval.id}`).send({ decision: 'reject', note: 'Already packed' }).expect(201);
      expect(res.body.action.status).toBe('rejected');
      expect(res.body.run.status).toBe('completed');
      expect(seq(res.body.run.steps).slice(-2)).toEqual(['tool:cancel_order', 'assistant:']);
      expect(toolResults(res.body.run.steps, 'cancel_order')[0]).toMatchObject({ status: 'rejected' });
      expect(res.body.run.steps.at(-1).content).toContain('A reviewer declined the cancellation of order #11');
      expect(res.body.run.steps.at(-1).content).toContain('Already packed');

      expect(await order(11)).toEqual({ status: 'processing', cancel_action_id: null });
      const log = await events(id);
      expect(log.map((e) => e.kind)).toEqual(['requested', 'rejected']);
      expect(log[1]).toMatchObject({ actorType: 'reviewer', note: 'Already packed' });
    });

    it('refuses to cancel what the guardrails protect, and parks nothing', async () => {
      const cases: Array<{ customerId: number; message: string; code: string; error: string; prepare?: string }> = [
        { customerId: 1, message: 'Cancel order #1', code: 'NOT_CANCELLABLE', error: 'This order is delivered and can no longer be cancelled' },
        { customerId: 6, message: 'Cancel order #6', code: 'ALREADY_CANCELLED', error: 'This order is already cancelled.' },
        // order 12 has a prior $10 refund; make it cancellable by status so only the refund stands in the way
        { customerId: 2, message: 'Cancel order #12', code: 'HAS_REFUNDS', error: 'refunds recorded', prepare: "UPDATE orders SET status = 'processing' WHERE id = 12" },
        { customerId: 1, message: 'Cancel order #999', code: 'NOT_FOUND', error: 'Order #999 was not found.' },
      ];
      for (const c of cases) {
        if (c.prepare) await pool.query(c.prepare);
        const id = await newConversation(c.customerId);
        const run = await say(id, c.message);
        expect(run.status).toBe('completed');
        const results = toolResults(run.steps, c.code === 'NOT_FOUND' ? 'get_order' : 'cancel_order');
        expect(results).toHaveLength(1);
        expect(results[0].code).toBe(c.code);
        expect(run.steps.at(-1).content).toContain("I wasn't able to do that:");
        expect(run.steps.at(-1).content).toContain(c.error);
        expect(await events(id)).toEqual([]);
      }
      expect(await pending()).toHaveLength(0);
      expect((await order(1)).status).toBe('delivered');
      expect((await order(12)).cancel_action_id).toBeNull();
    });

    it("never lets one customer cancel another's order", async () => {
      const id = await newConversation(1);
      const run = await say(id, 'Cancel order #2');
      expect(run.status).toBe('completed');
      expect(seq(run.steps)).toEqual(['user:', 'assistant:get_order', 'tool:get_order', 'assistant:']); // stops at the ownership check
      expect(toolResults(run.steps, 'get_order')[0].code).toBe('CROSS_CUSTOMER');
      expect(run.steps.at(-1).content).toContain('does not belong to the customer in this conversation');
      expect(await pending()).toHaveLength(0);
      expect(await events(id)).toEqual([]);
      expect((await order(2)).status).toBe('shipped');
    });

    it('refuses a refund on an order that was just cancelled', async () => {
      const id = await newConversation(1);
      await say(id, CANCEL_11);
      const [approval] = await pending();
      await http().post(`/approvals/${approval.id}`).send({ decision: 'approve' }).expect(201);

      const run = await say(id, 'Refund order #11');
      expect(run.status).toBe('completed');
      expect(seq(run.steps)).toEqual(['user:', 'assistant:get_order', 'tool:get_order', 'assistant:issue_refund', 'tool:issue_refund', 'assistant:']);
      expect(toolResults(run.steps, 'issue_refund')[0].code).toBe('ORDER_CANCELLED');
      expect(run.steps.at(-1).content).toContain('This order was cancelled and was never charged.');
      expect(await pending()).toHaveLength(0);
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM refunds WHERE order_id = 11');
      expect(rows[0].n).toBe(0);
      expect((await events(id)).map((e) => e.kind)).toEqual(['requested', 'approved']); // the refund never reached review
    });

    it('replaying an approved cancellation changes nothing, and a second decision is a conflict', async () => {
      const id = await newConversation(1);
      await say(id, CANCEL_11);
      const [approval] = await pending();
      await http().post(`/approvals/${approval.id}`).send({ decision: 'approve' }).expect(201);

      const { cancel_action_id: actionId } = await order(11);
      expect(actionId).toBe(approval.id);
      const shop = app.get(PgShopRepo);
      await expect(shop.cancelOrder({ customerId: 1, orderId: 11, actionId })).resolves.toEqual({ orderId: 11, status: 'cancelled' });
      expect(await order(11)).toEqual({ status: 'cancelled', cancel_action_id: approval.id });
      // the replay is recognised by the approval id: any other attempt on the cancelled order still fails
      await expect(shop.cancelOrder({ customerId: 1, orderId: 11, actionId: '22222222-2222-4222-8222-222222222222' }))
        .rejects.toMatchObject({ code: 'ALREADY_CANCELLED' });
      expect(await order(11)).toEqual({ status: 'cancelled', cancel_action_id: approval.id });

      await http().post(`/approvals/${approval.id}`).send({ decision: 'approve' }).expect(409);
      await http().post(`/approvals/${approval.id}`).send({ decision: 'reject' }).expect(409);
      expect(await order(11)).toEqual({ status: 'cancelled', cancel_action_id: approval.id });
    });
  });

  describe('with REFUND_AUTO_APPROVE_UNDER set very high', () => {
    beforeEach(() => {
      process.env.REFUND_AUTO_APPROVE_UNDER = '1000000';
      return boot();
    });

    it('still sends every cancellation to a human', async () => {
      // control: the same setting does auto-approve a refund, so the threshold really is in force
      const control = await newConversation(1);
      const refund = await say(control, 'Order #1 arrived damaged, please refund it');
      expect(refund.status).toBe('completed');
      expect((await pending())).toHaveLength(0);
      expect((await events(control)).map((e) => e.kind)).toEqual(['auto_approved']);

      const id = await newConversation(1);
      const run = await say(id, CANCEL_11);
      expect(run.status).toBe('awaiting_approval');
      expect(await order(11)).toEqual({ status: 'processing', cancel_action_id: null });
      const [approval] = await pending();
      expect(approval).toMatchObject({ toolName: 'cancel_order', policyRule: 'tool_requires_review' });

      await http().post(`/approvals/${approval.id}`).send({ decision: 'approve' }).expect(201);
      expect((await events(id)).map((e) => e.kind)).toEqual(['requested', 'approved']);
      expect(await order(11)).toEqual({ status: 'cancelled', cancel_action_id: approval.id });
    });
  });

  describe('tracking a shipment', () => {
    beforeEach(() => boot());

    it("reports the carrier, tracking number and latest scan of the customer's shipped order", async () => {
      const id = await newConversation(2);
      const run = await say(id, 'Where is my order #2?');
      expect(run.status).toBe('completed');
      expect(seq(run.steps)).toEqual(['user:', 'assistant:track_shipment', 'tool:track_shipment', 'assistant:']);
      expect(toolResults(run.steps, 'track_shipment')[0]).toMatchObject({
        shipped: true, orderId: 2, carrier: 'DHL', trackingNumber: ORDER_2_TRACKING, status: 'in_transit',
      });
      const answer = run.steps.at(-1).content;
      expect(answer).toContain('shipped with DHL');
      expect(answer).toContain(`tracking ${ORDER_2_TRACKING}`);
      expect(answer).toContain('in_transit');
      expect(answer).toContain('Arrived at regional facility (Denver, CO)');
    });

    it('reports a delivered order as delivered', async () => {
      const id = await newConversation(1);
      const run = await say(id, 'Where is my order #1?');
      expect(seq(run.steps)).toEqual(['user:', 'assistant:track_shipment', 'tool:track_shipment', 'assistant:']);
      expect(toolResults(run.steps, 'track_shipment')[0]).toMatchObject({ shipped: true, orderId: 1, carrier: 'FedEx', trackingNumber: 'FX900007919', status: 'delivered' });
      expect(run.steps.at(-1).content).toContain('shipped with FedEx (tracking FX900007919): delivered');
      expect(run.steps.at(-1).content).toContain('Latest: Delivered (Front door)');
    });

    it('says a processing order has not shipped yet', async () => {
      const id = await newConversation(1);
      const run = await say(id, 'Where is my order #11?');
      expect(toolResults(run.steps, 'track_shipment')).toEqual([{ shipped: false, orderId: 11, orderStatus: 'processing' }]);
      expect(run.steps.at(-1).content).toBe('Order #11 has not shipped yet (it is processing).');
    });

    it("never leaks another customer's shipment", async () => {
      const id = await newConversation(1);
      const res = await http().post(`/conversations/${id}/messages`).send({ content: 'Where is my order #2?' }).expect(201);
      const { run } = res.body;
      expect(run.status).toBe('completed');
      expect(seq(run.steps)).toEqual(['user:', 'assistant:track_shipment', 'tool:track_shipment', 'assistant:']);
      expect(toolResults(run.steps, 'track_shipment')).toEqual([
        { error: 'Access denied: Order #2 does not belong to the customer in this conversation.', code: 'CROSS_CUSTOMER' },
      ]);
      expect(run.steps.at(-1).content).toContain("I wasn't able to do that: Access denied");
      for (const secret of [ORDER_2_TRACKING, 'DHL', 'in_transit', 'Denver']) {
        expect(JSON.stringify(res.body)).not.toContain(secret);
        expect(JSON.stringify((await http().get(`/conversations/${id}`).expect(200)).body)).not.toContain(secret);
      }
    });
  });

  describe("a customer's view of a parked cancellation", () => {
    beforeEach(() => {
      process.env.REVIEWER_API_KEY = 's3cret';
      return boot();
    });

    it('shows the action but not why a human was needed', async () => {
      const res = await http().post('/conversations').send({ customerId: 1 }).expect(201);
      const id = res.body.id as string;
      const token = { 'X-Conversation-Token': res.body.accessToken as string };
      const reviewer = { Authorization: 'Bearer s3cret' };
      await http().post(`/conversations/${id}/messages`).set(token).send({ content: CANCEL_11 }).expect(201);

      const mine = (await http().get(`/conversations/${id}`).set(token).expect(200)).body;
      expect(mine.approvals).toHaveLength(1);
      expect(mine.approvals[0]).toMatchObject({ toolName: 'cancel_order', status: 'pending_approval', toolArgs: { orderId: 11 } });
      expect(mine.approvals[0]).not.toHaveProperty('policyRule');
      expect(mine.approvals[0]).not.toHaveProperty('policyDetail');
      expect(JSON.stringify(mine)).not.toContain('tool_requires_review');

      const theirs = (await http().get(`/conversations/${id}`).set(reviewer).expect(200)).body;
      expect(theirs.approvals[0]).toMatchObject({ toolName: 'cancel_order', policyRule: 'tool_requires_review', orderStatus: 'processing' });

      // the audit log and the approval queue are reviewer-only
      await http().get(`/approvals/events?conversationId=${id}`).set(token).expect(401);
      await http().get('/approvals?status=pending').set(token).expect(401);
    });
  });
});
