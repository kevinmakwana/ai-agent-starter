import type { Pool } from 'pg';
import { GuardrailViolation } from '../agent/errors';
import { assertRefundable, assertSameCustomer } from '../agent/guardrails';
import type { Customer, Order, ShopRepo, Ticket } from '../agent/types';
import { camel } from './pool';

export class PgShopRepo implements ShopRepo {
  constructor(private readonly pool: Pool) {}

  async getCustomer(id: number): Promise<Customer | null> {
    const { rows } = await this.pool.query('SELECT id, name, email FROM customers WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async listOrders(customerId: number): Promise<Order[]> {
    const { rows } = await this.pool.query('SELECT * FROM orders WHERE customer_id = $1 ORDER BY id', [customerId]);
    return rows.map((r) => camel<Order>(r));
  }

  async getOrder(orderId: number): Promise<Order | null> {
    const { rows } = await this.pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    return rows[0] ? camel<Order>(rows[0]) : null;
  }

  async totalRefunded(orderId: number): Promise<number> {
    const { rows } = await this.pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE order_id = $1', [orderId]);
    return rows[0].total;
  }

  async createTicket(input: { customerId: number; subject: string; body: string }): Promise<Ticket> {
    const { rows } = await this.pool.query(
      'INSERT INTO tickets (customer_id, subject, body) VALUES ($1, $2, $3) RETURNING *',
      [input.customerId, input.subject, input.body],
    );
    return camel<Ticket>(rows[0]);
  }

  async createRefund(input: { customerId: number; orderId: number; amount: number; reason: string; actionId?: string }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Row lock serialises concurrent refunds on the same order, so two approvals cannot both pass the check.
      const o = await client.query('SELECT customer_id, status, total FROM orders WHERE id = $1 FOR UPDATE', [input.orderId]);
      if (!o.rows[0]) throw new GuardrailViolation('NOT_FOUND', `Order #${input.orderId} was not found.`);
      assertSameCustomer(input.customerId, o.rows[0].customer_id, `Order #${input.orderId}`);
      if (input.actionId) {
        // Replay of an approval whose refund already committed (e.g. the reply was lost): return it, never pay twice.
        const done = await client.query('SELECT id FROM refunds WHERE action_id = $1', [input.actionId]);
        if (done.rows[0]) {
          const total = await client.query('SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE order_id = $1', [input.orderId]);
          await client.query('COMMIT');
          return { refundId: done.rows[0].id as number, refundedTotal: total.rows[0].total as number };
        }
      }
      const prior = await client.query('SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE order_id = $1', [input.orderId]);
      assertRefundable({ amount: input.amount, orderTotal: o.rows[0].total, priorRefunded: prior.rows[0].total, status: o.rows[0].status });
      const ins = await client.query(
        'INSERT INTO refunds (order_id, amount, reason, action_id) VALUES ($1, $2, $3, $4) RETURNING id',
        [input.orderId, input.amount, input.reason, input.actionId ?? null],
      );
      await client.query('COMMIT');
      return { refundId: ins.rows[0].id as number, refundedTotal: Math.round((prior.rows[0].total + input.amount) * 100) / 100 };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
