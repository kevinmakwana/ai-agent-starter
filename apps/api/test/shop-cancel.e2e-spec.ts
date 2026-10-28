import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { PgShopRepo } from '../src/db/pg-shop.repo';
import { seedDatabase, TOTAL_ORDERS } from '../src/db/seed-data';
import { PG_POOL } from '../src/tokens';

// Runs against a real Postgres; skipped unless E2E_DATABASE_URL is set (CI sets it).
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

// Seeded facts: order N belongs to customer ((N-1) % 10) + 1; order 11 is processing, 2 shipped, 1 delivered, 6 cancelled.
const ownerOf = (orderId: number) => ((orderId - 1) % 10) + 1;

maybe('cancelOrder and getShipment in the store (real Postgres)', () => {
  let app: INestApplication;
  let shop: PgShopRepo;
  let pool: Pool;

  beforeEach(async () => {
    process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
    process.env.LLM_PROVIDER = 'mock';
    process.env.MOCK_DELAY_MS = '0';
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    await app.init();
    shop = app.get(PgShopRepo);
    pool = app.get(PG_POOL);
    await seedDatabase(pool);
  });
  afterEach(() => app?.close());

  const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: { code?: string }) => e.code);
  const statusOf = async (orderId: number) => (await shop.getOrder(orderId))!.status;

  it('cancels a processing order and never exposes the internal action column', async () => {
    expect(await shop.cancelOrder({ customerId: 1, orderId: 11, actionId: randomUUID() })).toEqual({ orderId: 11, status: 'cancelled' });
    const order = await shop.getOrder(11);
    expect(order!.status).toBe('cancelled');
    expect(order).not.toHaveProperty('cancelActionId');
    expect((await shop.listOrders(1)).every((o) => !('cancelActionId' in o))).toBe(true);
  });

  it('treats a replay of the same action id as the same result, not an error', async () => {
    const actionId = randomUUID();
    const first = await shop.cancelOrder({ customerId: 1, orderId: 11, actionId });
    await expect(shop.cancelOrder({ customerId: 1, orderId: 11, actionId })).resolves.toEqual(first);
    expect(await statusOf(11)).toBe('cancelled');
  });

  describe('refusals', () => {
    it('refuses shipped and delivered orders', async () => {
      expect(await rejection(shop.cancelOrder({ customerId: 2, orderId: 2, actionId: randomUUID() }))).toBe('NOT_CANCELLABLE');
      expect(await rejection(shop.cancelOrder({ customerId: 1, orderId: 1, actionId: randomUUID() }))).toBe('NOT_CANCELLABLE');
      expect(await statusOf(2)).toBe('shipped');
      expect(await statusOf(1)).toBe('delivered');
    });

    it('refuses an already cancelled order, also when cancelled by another action', async () => {
      await shop.cancelOrder({ customerId: 1, orderId: 11, actionId: randomUUID() });
      expect(await rejection(shop.cancelOrder({ customerId: 1, orderId: 11, actionId: randomUUID() }))).toBe('ALREADY_CANCELLED');
      expect(await rejection(shop.cancelOrder({ customerId: 6, orderId: 6, actionId: randomUUID() }))).toBe('ALREADY_CANCELLED');
      expect(await statusOf(11)).toBe('cancelled');
    });

    it('refuses a processing order that has a refund recorded', async () => {
      await pool.query("INSERT INTO refunds (order_id, amount, reason) VALUES (11, 5.00, 'Goodwill')");
      expect(await rejection(shop.cancelOrder({ customerId: 1, orderId: 11, actionId: randomUUID() }))).toBe('HAS_REFUNDS');
      expect(await statusOf(11)).toBe('processing');
    });

    it("refuses another customer's order and an unknown order", async () => {
      expect(await rejection(shop.cancelOrder({ customerId: 2, orderId: 11, actionId: randomUUID() }))).toBe('CROSS_CUSTOMER');
      expect(await rejection(shop.cancelOrder({ customerId: 1, orderId: 9999, actionId: randomUUID() }))).toBe('NOT_FOUND');
      expect(await statusOf(11)).toBe('processing');
    });
  });

  it('never both cancels and refunds an order when the two race', async () => {
    for (const orderId of [4, 11, 18, 25]) {
      for (let i = 0; i < 3; i++) {
        await pool.query("UPDATE orders SET status = 'processing', cancel_action_id = NULL WHERE id = $1", [orderId]);
        await pool.query('DELETE FROM refunds WHERE order_id = $1', [orderId]);
        const customerId = ownerOf(orderId);
        const results = await Promise.allSettled([
          shop.cancelOrder({ customerId, orderId, actionId: randomUUID() }),
          shop.createRefund({ customerId, orderId, amount: 1, reason: 'race', actionId: randomUUID() }),
        ]);
        const refunds = await shop.totalRefunded(orderId);
        const cancelled = (await statusOf(orderId)) === 'cancelled';
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(cancelled && refunds > 0).toBe(false);
        expect(results[0].status === 'fulfilled').toBe(cancelled);
      }
    }
  });

  it('returns a shipment for every shipped or delivered order and none otherwise', async () => {
    for (let orderId = 1; orderId <= TOTAL_ORDERS; orderId++) {
      const status = await statusOf(orderId);
      const shipment = await shop.getShipment(orderId);
      if (status === 'shipped' || status === 'delivered') {
        expect(shipment).toEqual({
          orderId,
          carrier: expect.any(String),
          trackingNumber: expect.stringMatching(/^[A-Z0-9]+$/),
          status: status === 'delivered' ? 'delivered' : expect.stringMatching(/^(in_transit|out_for_delivery)$/),
          eta: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          events: expect.any(Array),
        });
        expect(shipment!.events.length).toBeGreaterThanOrEqual(3);
        expect(shipment!.events[0]).toEqual({ at: expect.stringMatching(/^\d{4}-/), location: expect.any(String), description: expect.any(String) });
      } else {
        expect(shipment).toBeNull();
      }
    }
  });
});
