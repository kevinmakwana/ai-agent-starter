import type { Pool } from 'pg';
import { PgReviewerStore } from '../src/auth/pg-reviewer.store';
import { createPool, ensureSchema } from '../src/db/pool';
import { seedDatabase } from '../src/db/seed-data';

// Runs against a real Postgres; skipped unless E2E_DATABASE_URL is set (CI sets it).
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

maybe('reviewer store (e2e, real Postgres)', () => {
  let pool: Pool;
  let store: PgReviewerStore;
  const newReviewer = (email = 'a@example.com', role: 'admin' | 'reviewer' = 'reviewer') =>
    store.createReviewer({ email, name: 'Alex', role, passwordHash: 'scrypt$x' });

  beforeAll(async () => {
    pool = createPool(process.env.E2E_DATABASE_URL!);
    await ensureSchema(pool);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE reviewers, reviewer_sessions CASCADE');
    store = new PgReviewerStore(pool);
  });
  // other suites expect the seeded shop and no reviewers (demo mode); leave the database as we found it
  afterAll(async () => {
    await seedDatabase(pool);
    await pool.end();
  });

  describe('reviewers', () => {
    it('creates, finds by email (any case) and by id, and never returns the hash from the public view', async () => {
      const r = await newReviewer('Mixed@Example.com');
      expect(r).toMatchObject({ email: 'mixed@example.com', role: 'reviewer', active: true, lastLoginAt: null });
      expect(Object.keys(r).sort()).toEqual(['active', 'createdAt', 'email', 'id', 'lastLoginAt', 'name', 'role']);
      expect((await store.findByEmail('MIXED@example.com'))?.id).toBe(r.id);
      expect((await store.findByEmail('MIXED@example.com'))).toMatchObject({ passwordHash: 'scrypt$x', locked: false });
      expect(await store.findById(r.id)).toEqual(r);
      expect(await store.findByEmail('nobody@example.com')).toBeNull();
      expect(await store.listReviewers()).toEqual([r]);
    });

    it('rejects a duplicate email in any case with EMAIL_TAKEN', async () => {
      await newReviewer('dup@example.com');
      await expect(newReviewer('DUP@example.com')).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
    });

    it('the database itself refuses a mixed-case email', async () => {
      await expect(pool.query(`INSERT INTO reviewers (email, name, password_hash, role) VALUES ('X@Y.com', 'x', 'h', 'admin')`)).rejects.toThrow();
    });

    it('hasAnyReviewer flips to true after createReviewer even inside the cache window', async () => {
      expect(await store.hasAnyReviewer()).toBe(false);
      expect(await store.hasAnyReviewer()).toBe(false); // cached
      await newReviewer();
      expect(await store.hasAnyReviewer()).toBe(true);
    });

    it('counts active admins only', async () => {
      const a = await newReviewer('a@example.com', 'admin');
      await newReviewer('b@example.com', 'admin');
      await newReviewer('c@example.com', 'reviewer');
      expect(await store.countActiveAdmins()).toBe(2);
      await store.updateReviewer(a.id, { active: false });
      expect(await store.countActiveAdmins()).toBe(1);
    });

    it('updates only the given fields and returns null for an unknown id', async () => {
      const r = await newReviewer();
      expect(await store.updateReviewer(r.id, { name: 'Renamed' })).toMatchObject({ name: 'Renamed', role: 'reviewer', active: true });
      expect((await store.findByEmail(r.email))?.passwordHash).toBe('scrypt$x');
      expect(await store.updateReviewer('00000000-0000-0000-0000-000000000000', { name: 'x' })).toBeNull();
    });
  });

  describe('sessions', () => {
    it('resolves a live session to its reviewer and nothing else', async () => {
      const r = await newReviewer();
      await store.createSession(r.id, 'hash-1', 12);
      expect(await store.resolveSession('hash-1')).toEqual({ id: r.id, email: r.email, name: r.name, role: r.role });
      expect(await store.resolveSession('other')).toBeNull();
    });

    it('stops resolving after the absolute expiry', async () => {
      const r = await newReviewer();
      await store.createSession(r.id, 'hash-1', 12);
      await pool.query(`UPDATE reviewer_sessions SET expires_at = now() - interval '1 second'`);
      expect(await store.resolveSession('hash-1')).toBeNull();
    });

    it('stops resolving after 30 idle minutes, and a use refreshes last_seen at most once a minute', async () => {
      const r = await newReviewer();
      await store.createSession(r.id, 'hash-1', 12);
      await pool.query(`UPDATE reviewer_sessions SET last_seen_at = now() - interval '29 minutes'`);
      expect(await store.resolveSession('hash-1')).not.toBeNull();
      const { rows } = await pool.query(`SELECT last_seen_at > now() - interval '5 seconds' AS fresh FROM reviewer_sessions`);
      expect(rows[0].fresh).toBe(true);
      await pool.query(`UPDATE reviewer_sessions SET last_seen_at = now() - interval '31 minutes'`);
      expect(await store.resolveSession('hash-1')).toBeNull();

      await pool.query(`UPDATE reviewer_sessions SET last_seen_at = now() - interval '10 seconds'`);
      const before = (await pool.query('SELECT last_seen_at FROM reviewer_sessions')).rows[0].last_seen_at;
      await store.resolveSession('hash-1');
      expect((await pool.query('SELECT last_seen_at FROM reviewer_sessions')).rows[0].last_seen_at).toBe(before);
    });

    it('a deactivated reviewer no longer resolves, and the session row is deleted', async () => {
      const r = await newReviewer();
      await store.createSession(r.id, 'hash-1', 12);
      await store.updateReviewer(r.id, { active: false });
      expect(await store.resolveSession('hash-1')).toBeNull();
      expect((await pool.query('SELECT count(*)::int AS n FROM reviewer_sessions')).rows[0].n).toBe(0);
    });

    it('a password change or demotion deletes other sessions and keeps the named one; promotion deletes none', async () => {
      const r = await newReviewer('a@example.com', 'admin');
      await store.createSession(r.id, 'mine', 12);
      await store.createSession(r.id, 'other', 12);
      await store.updateReviewer(r.id, { role: 'admin', name: 'Same' });
      expect((await pool.query('SELECT count(*)::int AS n FROM reviewer_sessions')).rows[0].n).toBe(2);
      await store.updateReviewer(r.id, { passwordHash: 'scrypt$new' }, { keepSession: 'mine' });
      expect(await store.resolveSession('mine')).not.toBeNull();
      expect(await store.resolveSession('other')).toBeNull();
      await store.createSession(r.id, 'again', 12);
      await store.updateReviewer(r.id, { role: 'reviewer' });
      expect(await store.resolveSession('mine')).toBeNull();
      expect(await store.resolveSession('again')).toBeNull();
    });

    it('deletes one session, all of a reviewer (except one) and expired ones', async () => {
      const a = await newReviewer('a@example.com');
      const b = await newReviewer('b@example.com');
      await store.createSession(a.id, 'a1', 12);
      await store.createSession(a.id, 'a2', 12);
      await store.createSession(b.id, 'b1', 12);
      await store.deleteSession('a1');
      expect(await store.resolveSession('a1')).toBeNull();
      await store.deleteSessionsForReviewer(a.id, 'a2');
      expect(await store.resolveSession('a2')).not.toBeNull();
      await store.deleteSessionsForReviewer(a.id);
      expect(await store.resolveSession('a2')).toBeNull();
      expect(await store.resolveSession('b1')).not.toBeNull();
      await pool.query(`UPDATE reviewer_sessions SET expires_at = now() - interval '1 minute'`);
      await store.createSession(b.id, 'b2', 12);
      await store.deleteExpired();
      expect((await pool.query('SELECT token_hash FROM reviewer_sessions')).rows).toEqual([{ token_hash: 'b2' }]);
    });

    it('a session whose reviewer was deactivated behind the store\'s back (plain SQL) still does not resolve', async () => {
      const r = await newReviewer();
      await store.createSession(r.id, 'hash-1', 12);
      await pool.query('UPDATE reviewers SET active = false');
      expect(await store.resolveSession('hash-1')).toBeNull();
    });

    it('rejects a duplicate token hash', async () => {
      const r = await newReviewer();
      await store.createSession(r.id, 'dup', 12);
      await expect(store.createSession(r.id, 'dup', 12)).rejects.toThrow();
    });
  });

  describe('lockout counters', () => {
    it('10 concurrent failures end at 10 and locked', async () => {
      const r = await newReviewer();
      await Promise.all(Array.from({ length: 10 }, () => store.recordLoginFailure(r.id)));
      const { rows } = await pool.query('SELECT failed_attempts, locked_until > now() AS locked FROM reviewers');
      expect(rows[0]).toEqual({ failed_attempts: 10, locked: true });
      expect((await store.findByEmail(r.email))?.locked).toBe(true);
    });

    it('locks at the fifth failure, not before', async () => {
      const r = await newReviewer();
      for (let i = 0; i < 4; i++) await store.recordLoginFailure(r.id);
      expect((await store.findByEmail(r.email))?.locked).toBe(false);
      await store.recordLoginFailure(r.id);
      expect((await store.findByEmail(r.email))?.locked).toBe(true);
    });

    it('a failure after the lock expired starts again at 1 instead of re-locking', async () => {
      const r = await newReviewer();
      for (let i = 0; i < 5; i++) await store.recordLoginFailure(r.id);
      await pool.query(`UPDATE reviewers SET locked_until = now() - interval '1 second'`);
      expect((await store.findByEmail(r.email))?.locked).toBe(false);
      await store.recordLoginFailure(r.id);
      expect((await pool.query('SELECT failed_attempts, locked_until FROM reviewers')).rows[0]).toEqual({ failed_attempts: 1, locked_until: null });
    });

    it('a success clears the counter and the lock and stamps last_login_at', async () => {
      const r = await newReviewer();
      for (let i = 0; i < 5; i++) await store.recordLoginFailure(r.id);
      await store.recordLoginSuccess(r.id);
      expect((await pool.query('SELECT failed_attempts, locked_until, last_login_at IS NOT NULL AS stamped FROM reviewers')).rows[0])
        .toEqual({ failed_attempts: 0, locked_until: null, stamped: true });
    });
  });
});
