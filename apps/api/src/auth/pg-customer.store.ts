import type { Pool } from 'pg';
import { CUSTOMER_IDLE_HOURS, type CustomerAuthStore, type CustomerIdentity } from './customer.store';

export class PgCustomerAuthStore implements CustomerAuthStore {
  constructor(private readonly pool: Pool) {}

  async findCustomerByEmail(email: string): Promise<CustomerIdentity | null> {
    const { rows } = await this.pool.query('SELECT id, name, email FROM customers WHERE lower(email) = lower($1)', [email]);
    return rows[0] ?? null;
  }

  async createLoginLink(customerId: number, tokenHash: string, ttlMinutes: number, limits: { maxPerHour: number; keepUnused: number }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One lock per customer, so counting and inserting are one decision even for simultaneous requests.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`login-link:${customerId}`]);
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM login_links WHERE customer_id = $1 AND created_at > now() - interval '1 hour'`, [customerId]);
      if (rows[0].n >= limits.maxPerHour) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        'INSERT INTO login_links (customer_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))',
        [customerId, tokenHash, ttlMinutes],
      );
      // Only the newest few unused links stay usable.
      await client.query(
        `UPDATE login_links SET expires_at = now()
          WHERE customer_id = $1 AND used_at IS NULL AND expires_at > now()
            AND id NOT IN (SELECT id FROM login_links WHERE customer_id = $1 AND used_at IS NULL AND expires_at > now()
                           ORDER BY created_at DESC, id DESC LIMIT $2)`,
        [customerId, limits.keepUnused],
      );
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** One statement: two requests with the same token cannot both succeed. */
  async consumeLoginLink(tokenHash: string): Promise<CustomerIdentity | null> {
    const { rows } = await this.pool.query(
      `UPDATE login_links l SET used_at = now() FROM customers c
        WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.expires_at > now() AND c.id = l.customer_id
        RETURNING c.id, c.name, c.email`,
      [tokenHash],
    );
    return rows[0] ?? null;
  }

  async createSession(customerId: number, tokenHash: string, ttlDays: number): Promise<void> {
    await this.pool.query(
      'INSERT INTO customer_sessions (customer_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))',
      [customerId, tokenHash, ttlDays],
    );
  }

  async resolveSession(tokenHash: string): Promise<CustomerIdentity | null> {
    const { rows } = await this.pool.query(
      `SELECT c.id, c.name, c.email FROM customer_sessions s JOIN customers c ON c.id = s.customer_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(hours => $2)`,
      [tokenHash, CUSTOMER_IDLE_HOURS],
    );
    if (!rows[0]) return null;
    // at most one write a minute per session
    await this.pool.query(
      `UPDATE customer_sessions SET last_seen_at = now() WHERE token_hash = $1 AND last_seen_at < now() - interval '1 minute'`, [tokenHash]);
    return rows[0];
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM customer_sessions WHERE token_hash = $1', [tokenHash]);
  }

  async deleteSessionsForCustomer(customerId: number): Promise<void> {
    await this.pool.query('DELETE FROM customer_sessions WHERE customer_id = $1', [customerId]);
  }

  async deleteExpired(): Promise<void> {
    await this.pool.query(
      'DELETE FROM customer_sessions WHERE expires_at <= now() OR last_seen_at <= now() - make_interval(hours => $1)', [CUSTOMER_IDLE_HOURS]);
    await this.pool.query(`DELETE FROM login_links WHERE expires_at < now() - interval '1 day'`);
  }
}
