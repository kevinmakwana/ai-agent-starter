import type { Pool } from 'pg';
import { PgCustomerAuthStore } from '../src/auth/pg-customer.store';
import { createPool, ensureSchema } from '../src/db/pool';
import { seedDatabase } from '../src/db/seed-data';

// Runs against a real Postgres; skipped unless E2E_DATABASE_URL is set (CI sets it).
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;
const LIMITS = { maxPerHour: 5, keepUnused: 2 };

maybe('customer auth store (e2e, real Postgres)', () => {
  let pool: Pool;
  let store: PgCustomerAuthStore;

  beforeAll(async () => {
    pool = createPool(process.env.E2E_DATABASE_URL!);
    await ensureSchema(pool);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE login_links, customer_sessions CASCADE');
    store = new PgCustomerAuthStore(pool);
  });
  // other suites expect the seeded shop and no reviewers; leave the database as we found it
  afterAll(async () => {
    await seedDatabase(pool);
    await pool.end();
  });

  it('finds a customer by email in any case, and only a real one', async () => {
    const { rows } = await pool.query('SELECT id, name, email FROM customers ORDER BY id LIMIT 1');
    expect(await store.findCustomerByEmail(rows[0].email.toUpperCase())).toEqual(rows[0]);
    expect(await store.findCustomerByEmail('nobody@example.com')).toBeNull();
  });

  describe('login links', () => {
    it('are consumed once, by hash, and give back the customer', async () => {
      expect(await store.createLoginLink(1, 'h1', 15, LIMITS)).toBe(true);
      expect(await store.consumeLoginLink('h1')).toMatchObject({ id: 1 });
      expect(await store.consumeLoginLink('h1')).toBeNull();
      expect(await store.consumeLoginLink('unknown')).toBeNull();
    });

    it('stop working when they expire', async () => {
      await store.createLoginLink(1, 'h1', 15, LIMITS);
      await pool.query(`UPDATE login_links SET expires_at = now() - interval '1 second'`);
      expect(await store.consumeLoginLink('h1')).toBeNull();
    });

    it('eight concurrent consumers of one link: exactly one wins', async () => {
      await store.createLoginLink(1, 'h1', 15, LIMITS);
      await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT pg_sleep(0.05)'))); // open connections first
      const results = await Promise.all(Array.from({ length: 8 }, () => store.consumeLoginLink('h1')));
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it('keep only the newest unused ones, per customer', async () => {
      for (const h of ['a1', 'a2', 'a3']) { await store.createLoginLink(1, h, 15, LIMITS); await pool.query('SELECT pg_sleep(0.01)'); }
      await store.createLoginLink(2, 'b1', 15, LIMITS);
      expect(await store.consumeLoginLink('a1')).toBeNull();
      expect(await store.consumeLoginLink('a2')).not.toBeNull();
      expect(await store.consumeLoginLink('a3')).not.toBeNull();
      expect(await store.consumeLoginLink('b1')).not.toBeNull();
    });

    it('are limited to 5 per customer per rolling hour, even when requested at the same instant', async () => {
      await Promise.all(Array.from({ length: 6 }, () => pool.query('SELECT pg_sleep(0.05)')));
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.createLoginLink(1, `h${i}`, 15, LIMITS)));
      expect(results.filter(Boolean)).toHaveLength(5);
      expect((await pool.query('SELECT count(*)::int AS n FROM login_links WHERE customer_id = 1')).rows[0].n).toBe(5);
      await pool.query(`UPDATE login_links SET created_at = now() - interval '61 minutes'`);
      expect(await store.createLoginLink(1, 'later', 15, LIMITS)).toBe(true);
    });

    it('deleteExpired removes links that expired more than a day ago and keeps recent ones', async () => {
      await store.createLoginLink(1, 'old', 15, LIMITS);
      await store.createLoginLink(2, 'new', 15, LIMITS);
      await pool.query(`UPDATE login_links SET expires_at = now() - interval '2 days' WHERE token_hash = 'old'`);
      await store.deleteExpired();
      expect((await pool.query('SELECT token_hash FROM login_links')).rows).toEqual([{ token_hash: 'new' }]);
    });
  });

  describe('sessions', () => {
    it('resolve to the customer and nothing else', async () => {
      await store.createSession(1, 's1', 7);
      expect(await store.resolveSession('s1')).toMatchObject({ id: 1, name: expect.any(String), email: expect.any(String) });
      expect(await store.resolveSession('other')).toBeNull();
    });

    it('stop after the absolute expiry and after 24 idle hours; a use refreshes at most once a minute', async () => {
      await store.createSession(1, 's1', 7);
      await pool.query(`UPDATE customer_sessions SET expires_at = now() - interval '1 second'`);
      expect(await store.resolveSession('s1')).toBeNull();

      await pool.query('TRUNCATE customer_sessions');
      await store.createSession(1, 's2', 7);
      await pool.query(`UPDATE customer_sessions SET last_seen_at = now() - interval '23 hours'`);
      expect(await store.resolveSession('s2')).not.toBeNull();
      expect((await pool.query(`SELECT last_seen_at > now() - interval '5 seconds' AS fresh FROM customer_sessions`)).rows[0].fresh).toBe(true);
      await pool.query(`UPDATE customer_sessions SET last_seen_at = now() - interval '25 hours'`);
      expect(await store.resolveSession('s2')).toBeNull();

      await pool.query(`UPDATE customer_sessions SET last_seen_at = now() - interval '10 seconds'`);
      const before = (await pool.query('SELECT last_seen_at FROM customer_sessions')).rows[0].last_seen_at;
      await store.resolveSession('s2');
      expect((await pool.query('SELECT last_seen_at FROM customer_sessions')).rows[0].last_seen_at).toBe(before);
    });

    it('delete one, all of a customer, and expired ones; a duplicate hash is refused', async () => {
      await store.createSession(1, 'a1', 7);
      await store.createSession(1, 'a2', 7);
      await store.createSession(2, 'b1', 7);
      await expect(store.createSession(1, 'a1', 7)).rejects.toThrow();
      await store.deleteSession('a1');
      expect(await store.resolveSession('a1')).toBeNull();
      await store.deleteSessionsForCustomer(1);
      expect(await store.resolveSession('a2')).toBeNull();
      expect(await store.resolveSession('b1')).not.toBeNull();
      await pool.query(`UPDATE customer_sessions SET expires_at = now() - interval '1 minute'`);
      await store.createSession(2, 'b2', 7);
      await store.deleteExpired();
      expect((await pool.query('SELECT token_hash FROM customer_sessions')).rows).toEqual([{ token_hash: 'b2' }]);
    });
  });
});
