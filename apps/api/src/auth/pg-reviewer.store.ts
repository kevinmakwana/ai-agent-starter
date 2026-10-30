import { type Pool } from 'pg';
import { ConflictError } from '../agent/errors';
import { camel } from '../db/pool';
import {
  IDLE_TIMEOUT_MINUTES, LOCKOUT_AFTER_FAILURES, LOCKOUT_MINUTES,
  type NewReviewer, type Reviewer, type ReviewerCredentials, type ReviewerPatch, type ReviewerStore, type SessionReviewer,
} from './reviewer.store';

/** How long the "do any reviewers exist" answer is reused; creating a reviewer through this store resets it at once. */
const MODE_CACHE_MS = 5_000;

const VIEW = `id, email, name, role, active, created_at, last_login_at`;

const toReviewer = (row: Record<string, unknown>): Reviewer => {
  const r = camel(row) as Record<string, unknown>;
  return {
    id: r.id as string, email: r.email as string, name: r.name as string, role: r.role as Reviewer['role'], active: r.active as boolean,
    createdAt: new Date(r.createdAt as string).toISOString(),
    lastLoginAt: r.lastLoginAt ? new Date(r.lastLoginAt as string).toISOString() : null,
  };
};

export class PgReviewerStore implements ReviewerStore {
  private anyReviewer: { value: boolean; at: number } | null = null;

  constructor(private readonly pool: Pool) {}

  async createReviewer(r: NewReviewer): Promise<Reviewer> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO reviewers (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING ${VIEW}`,
        [r.email.trim().toLowerCase(), r.name, r.passwordHash, r.role],
      );
      return toReviewer(rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictError('A reviewer with this email already exists', 'EMAIL_TAKEN');
      throw e;
    } finally {
      this.anyReviewer = null;
    }
  }

  async findByEmail(email: string): Promise<ReviewerCredentials | null> {
    const { rows } = await this.pool.query(`SELECT ${VIEW}, password_hash, (locked_until IS NOT NULL AND locked_until > now()) AS locked FROM reviewers WHERE email = lower($1)`, [email]);
    if (!rows[0]) return null;
    return { ...toReviewer(rows[0]), passwordHash: rows[0].password_hash, locked: rows[0].locked };
  }

  async findById(id: string): Promise<Reviewer | null> {
    const { rows } = await this.pool.query(`SELECT ${VIEW} FROM reviewers WHERE id = $1`, [id]);
    return rows[0] ? toReviewer(rows[0]) : null;
  }

  async listReviewers(): Promise<Reviewer[]> {
    const { rows } = await this.pool.query(`SELECT ${VIEW} FROM reviewers ORDER BY created_at, email`);
    return rows.map(toReviewer);
  }

  async updateReviewer(id: string, patch: ReviewerPatch, opts: { keepSession?: string } = {}): Promise<Reviewer | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: before } = await client.query('SELECT role FROM reviewers WHERE id = $1 FOR UPDATE', [id]);
      if (!before[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const { rows } = await client.query(
        `UPDATE reviewers SET name = COALESCE($2, name), role = COALESCE($3, role), active = COALESCE($4, active),
                password_hash = COALESCE($5, password_hash)
          WHERE id = $1 RETURNING ${VIEW}`,
        [id, patch.name ?? null, patch.role ?? null, patch.active ?? null, patch.passwordHash ?? null],
      );
      const demoted = patch.role === 'reviewer' && before[0].role === 'admin';
      if (patch.active === false || patch.passwordHash !== undefined || demoted) {
        await client.query('DELETE FROM reviewer_sessions WHERE reviewer_id = $1 AND token_hash IS DISTINCT FROM $2', [id, opts.keepSession ?? null]);
      }
      await client.query('COMMIT');
      return toReviewer(rows[0]);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async countActiveAdmins(): Promise<number> {
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM reviewers WHERE role = 'admin' AND active`);
    return rows[0].n;
  }

  async hasAnyReviewer(): Promise<boolean> {
    if (this.anyReviewer && Date.now() - this.anyReviewer.at < MODE_CACHE_MS) return this.anyReviewer.value;
    const { rows } = await this.pool.query('SELECT EXISTS (SELECT 1 FROM reviewers) AS any');
    this.anyReviewer = { value: rows[0].any, at: Date.now() };
    return rows[0].any;
  }

  /**
   * One statement under a row lock, so concurrent failures all count. A failure after an expired lock starts the count
   * again at 1 instead of re-locking at once.
   */
  async recordLoginFailure(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE reviewers r SET failed_attempts = n.f,
              locked_until = CASE WHEN n.f >= $2 THEN now() + make_interval(mins => $3)
                                  WHEN r.locked_until <= now() THEN NULL ELSE r.locked_until END
         FROM (SELECT id, CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1 ELSE failed_attempts + 1 END AS f
                 FROM reviewers WHERE id = $1 FOR UPDATE) n
        WHERE r.id = n.id`,
      [id, LOCKOUT_AFTER_FAILURES, LOCKOUT_MINUTES],
    );
  }

  async recordLoginSuccess(id: string): Promise<void> {
    await this.pool.query('UPDATE reviewers SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [id]);
  }

  async createSession(reviewerId: string, tokenHash: string, ttlHours: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO reviewer_sessions (reviewer_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
      [reviewerId, tokenHash, ttlHours],
    );
  }

  async resolveSession(tokenHash: string): Promise<SessionReviewer | null> {
    const { rows } = await this.pool.query(
      `SELECT r.id, r.email, r.name, r.role FROM reviewer_sessions s JOIN reviewers r ON r.id = s.reviewer_id
        WHERE s.token_hash = $1 AND r.active AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(mins => $2)`,
      [tokenHash, IDLE_TIMEOUT_MINUTES],
    );
    if (!rows[0]) return null;
    // at most one write a minute per session
    await this.pool.query(`UPDATE reviewer_sessions SET last_seen_at = now() WHERE token_hash = $1 AND last_seen_at < now() - interval '1 minute'`, [tokenHash]);
    return rows[0];
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM reviewer_sessions WHERE token_hash = $1', [tokenHash]);
  }

  async deleteSessionsForReviewer(reviewerId: string, keepSession?: string): Promise<void> {
    await this.pool.query('DELETE FROM reviewer_sessions WHERE reviewer_id = $1 AND token_hash IS DISTINCT FROM $2', [reviewerId, keepSession ?? null]);
  }

  async deleteExpired(): Promise<void> {
    await this.pool.query(
      `DELETE FROM reviewer_sessions WHERE expires_at <= now() OR last_seen_at <= now() - make_interval(mins => $1)`,
      [IDLE_TIMEOUT_MINUTES],
    );
  }
}
