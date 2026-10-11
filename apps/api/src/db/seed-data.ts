import type { Pool } from 'pg';
import { RESET_SQL, SCHEMA_SQL } from './schema';

const CUSTOMERS = [
  ['Ava Brooks', 'ava.brooks@example.com'],
  ['Ben Carter', 'ben.carter@example.com'],
  ['Chloe Diaz', 'chloe.diaz@example.com'],
  ['Dev Patel', 'dev.patel@example.com'],
  ['Elena Rossi', 'elena.rossi@example.com'],
  ['Farid Nasser', 'farid.nasser@example.com'],
  ['Grace Liu', 'grace.liu@example.com'],
  ['Hugo Weber', 'hugo.weber@example.com'],
  ['Isla Murphy', 'isla.murphy@example.com'],
  ['Jonas Berg', 'jonas.berg@example.com'],
] as const;

const CATALOG = [
  { sku: 'MUG-01', name: 'Acme Ceramic Mug', unitPrice: 14.5 },
  { sku: 'TEE-02', name: 'Acme Logo T-Shirt', unitPrice: 24.99 },
  { sku: 'BTL-03', name: 'Insulated Water Bottle', unitPrice: 29.0 },
  { sku: 'BAG-04', name: 'Canvas Tote Bag', unitPrice: 18.75 },
  { sku: 'HAT-05', name: 'Acme Cap', unitPrice: 21.0 },
  { sku: 'NTB-06', name: 'Dotted Notebook', unitPrice: 9.95 },
  { sku: 'HDP-07', name: 'Wireless Headphones', unitPrice: 89.0 },
  { sku: 'LMP-08', name: 'Desk Lamp', unitPrice: 42.5 },
];

const STATUSES = ['delivered', 'delivered', 'shipped', 'delivered', 'processing', 'delivered', 'cancelled'] as const;

export const TOTAL_CUSTOMERS = CUSTOMERS.length;
export const TOTAL_ORDERS = 30;

/**
 * Deterministic seed: order N belongs to customer ((N-1) % 10) + 1, so customer 1 owns orders 1, 11, 21.
 * Order 12 has a prior partial refund, which makes the over-refund guardrail easy to demo.
 */
export async function seedDatabase(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
  await pool.query(RESET_SQL);

  for (const [name, email] of CUSTOMERS) {
    await pool.query('INSERT INTO customers (name, email) VALUES ($1, $2)', [name, email]);
  }

  for (let n = 1; n <= TOTAL_ORDERS; n++) {
    const customerId = ((n - 1) % TOTAL_CUSTOMERS) + 1;
    const items = Array.from({ length: 1 + (n % 3 === 0 ? 1 : 0) }, (_, k) => {
      const p = CATALOG[(n * 3 + k * 5) % CATALOG.length];
      return { ...p, qty: 1 + ((n + k) % 4 === 0 ? 1 : 0) };
    });
    const total = Math.round(items.reduce((s, i) => s + i.unitPrice * i.qty, 0) * 100) / 100;
    const status = STATUSES[n % STATUSES.length];
    await pool.query(
      `INSERT INTO orders (customer_id, status, total, items, created_at)
       VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval)`,
      [customerId, status, total, JSON.stringify(items), String(60 - n)],
    );
  }

  await pool.query(
    "INSERT INTO refunds (order_id, amount, reason) SELECT id, 10.00, 'Goodwill credit for late delivery' FROM orders WHERE id = 12 AND status <> 'cancelled'",
  );
  await pool.query(
    "INSERT INTO tickets (customer_id, subject, body) VALUES (3, 'Wrong colour received', 'The cap I received is navy, not black.')",
  );
}
