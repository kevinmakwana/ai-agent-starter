import { randomUUID } from 'node:crypto';
import { ConflictError } from '../src/agent/errors';
import {
  IDLE_TIMEOUT_MINUTES, LOCKOUT_AFTER_FAILURES, LOCKOUT_MINUTES,
  type NewReviewer, type Reviewer, type ReviewerCredentials, type ReviewerPatch, type ReviewerStore, type SessionReviewer,
} from '../src/auth/reviewer.store';

interface Row extends Omit<ReviewerCredentials, 'locked'> { failedAttempts: number; lockedUntil: Date | null }
interface SessionRow { reviewerId: string; createdAt: number; lastSeenAt: number; expiresAt: number }

/** In-memory ReviewerStore for unit tests; `now` is injectable so expiry can be tested without sleeping. */
export class MemoryReviewerStore implements ReviewerStore {
  rows = new Map<string, Row>();
  sessions = new Map<string, SessionRow>();
  now = () => Date.now();

  private view = (r: Row): Reviewer => ({
    id: r.id, email: r.email, name: r.name, role: r.role, active: r.active, createdAt: r.createdAt, lastLoginAt: r.lastLoginAt,
  });

  async createReviewer(r: NewReviewer) {
    const email = r.email.toLowerCase();
    if ([...this.rows.values()].some((x) => x.email === email)) throw new ConflictError('A reviewer with this email already exists');
    const row: Row = {
      id: randomUUID(), email, name: r.name, role: r.role, active: true, createdAt: new Date(this.now()).toISOString(),
      lastLoginAt: null, passwordHash: r.passwordHash, lockedUntil: null, failedAttempts: 0,
    };
    this.rows.set(row.id, row);
    return this.view(row);
  }

  async findByEmail(email: string) {
    const r = [...this.rows.values()].find((x) => x.email === email.toLowerCase());
    // deliberately returns the whole row (counters included), like a careless store would: the service must not leak extras
    return r ? { ...r, locked: r.lockedUntil !== null && r.lockedUntil.getTime() > this.now() } : null;
  }

  async findById(id: string) {
    const r = this.rows.get(id);
    return r ? this.view(r) : null;
  }

  async listReviewers() {
    return [...this.rows.values()].map(this.view);
  }

  async updateReviewer(id: string, patch: ReviewerPatch, opts: { keepSession?: string } = {}) {
    const r = this.rows.get(id);
    if (!r) return null;
    const revoke = patch.active === false || patch.passwordHash !== undefined || (patch.role === 'reviewer' && r.role === 'admin');
    Object.assign(r, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    if (revoke) await this.deleteSessionsForReviewer(id, opts.keepSession);
    return this.view(r);
  }

  async countActiveAdmins() {
    return [...this.rows.values()].filter((r) => r.role === 'admin' && r.active).length;
  }

  async hasAnyReviewer() {
    return this.rows.size > 0;
  }

  async recordLoginFailure(id: string) {
    const r = this.rows.get(id);
    if (!r) return;
    const expired = r.lockedUntil !== null && r.lockedUntil.getTime() <= this.now();
    r.failedAttempts = expired ? 1 : r.failedAttempts + 1;
    if (r.failedAttempts >= LOCKOUT_AFTER_FAILURES) r.lockedUntil = new Date(this.now() + LOCKOUT_MINUTES * 60_000);
    else if (expired) r.lockedUntil = null;
  }

  async recordLoginSuccess(id: string) {
    const r = this.rows.get(id);
    if (!r) return;
    r.failedAttempts = 0;
    r.lockedUntil = null;
    r.lastLoginAt = new Date(this.now()).toISOString();
  }

  async createSession(reviewerId: string, tokenHash: string, ttlHours: number) {
    const t = this.now();
    this.sessions.set(tokenHash, { reviewerId, createdAt: t, lastSeenAt: t, expiresAt: t + ttlHours * 3_600_000 });
  }

  async resolveSession(tokenHash: string): Promise<SessionReviewer | null> {
    const s = this.sessions.get(tokenHash);
    const r = s && this.rows.get(s.reviewerId);
    const t = this.now();
    if (!s || !r || !r.active || s.expiresAt <= t || s.lastSeenAt <= t - IDLE_TIMEOUT_MINUTES * 60_000) return null;
    if (s.lastSeenAt < t - 60_000) s.lastSeenAt = t;
    return { id: r.id, email: r.email, name: r.name, role: r.role };
  }

  async deleteSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }

  async deleteSessionsForReviewer(reviewerId: string, keepSession?: string) {
    for (const [hash, s] of this.sessions) if (s.reviewerId === reviewerId && hash !== keepSession) this.sessions.delete(hash);
  }

  async deleteExpired() {
    const t = this.now();
    for (const [hash, s] of this.sessions) if (s.expiresAt <= t || s.lastSeenAt <= t - IDLE_TIMEOUT_MINUTES * 60_000) this.sessions.delete(hash);
  }
}
