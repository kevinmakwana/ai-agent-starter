import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { assertUpToDate, checksum, migrate, pendingMigrations } from '../src/db/migrate';
import { MIGRATIONS, type Migration } from '../src/db/migrations';
import { createPool } from '../src/db/pool';
import { RESET_SQL } from '../src/db/schema';
import { seedDatabase } from '../src/db/seed-data';

// Real Postgres, one throwaway database per test; skipped unless E2E_DATABASE_URL is set (CI sets it). Needs CREATEDB.
const maybe = process.env.E2E_DATABASE_URL ? describe : describe.skip;

const FIXTURES = join(__dirname, 'fixtures', 'legacy-schemas');

maybe('database migrations (e2e)', () => {
  let admin: Pool;
  let name: string;
  let pool: Pool;
  const urlFor = (db: string) => {
    const u = new URL(process.env.E2E_DATABASE_URL!);
    u.pathname = `/${db}`;
    return u.toString();
  };

  /**
   * pool.end() resolves before the sockets are fully closed, and dropping a database kills any connection still open to it,
   * which pg reports as an unhandled error. So wait until the server shows no session on it, then drop.
   */
  const dropDatabase = async (db: string) => {
    for (let i = 0; i < 100; i++) {
      const { rows } = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [db]);
      if (rows[0].n === 0) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  };

  beforeAll(() => {
    admin = createPool(process.env.E2E_DATABASE_URL!);
  });
  afterAll(async () => {
    await admin.end();
  });
  beforeEach(async () => {
    name = `mig_${randomBytes(5).toString('hex')}_test`;
    await admin.query(`CREATE DATABASE "${name}"`);
    pool = createPool(urlFor(name));
  });
  afterEach(async () => {
    await pool.end();
    await dropDatabase(name);
    jest.restoreAllMocks();
  });

  /** Everything about the schema that code can depend on, in an order that does not depend on how the database got here. */
  const schemaDump = async (db: Pool) => ({
    columns: (
      await db.query(
        `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_schema = 'public' ORDER BY table_name, column_name`,
      )
    ).rows,
    indexes: (await db.query(`SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexdef`)).rows,
    constraints: (
      await db.query(
        `SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE connamespace = 'public'::regnamespace ORDER BY tbl, conname`,
      )
    ).rows,
  });

  describe('a new database', () => {
    it('gets the whole schema and records the baseline with its checksum', async () => {
      expect(await migrate(pool)).toEqual([1]);
      const { rows } = await pool.query('SELECT version, name, checksum FROM schema_migrations');
      expect(rows).toEqual([{ version: 1, name: 'baseline', checksum: checksum(MIGRATIONS[0].sql) }]);
      const tables = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map(
        (r) => r.table_name,
      );
      expect(tables).toEqual(
        expect.arrayContaining(['customers', 'orders', 'runs', 'steps', 'actions', 'reviewers', 'login_links', 'shipments']),
      );
    });

    it('does nothing the second time', async () => {
      await migrate(pool);
      const before = (await pool.query('SELECT applied_at FROM schema_migrations')).rows;
      expect(await migrate(pool)).toEqual([]);
      expect((await pool.query('SELECT applied_at FROM schema_migrations')).rows).toEqual(before);
    });

    it('survives several processes migrating at once: one applies, the rest wait and find nothing to do', async () => {
      const pools = Array.from({ length: 6 }, () => createPool(urlFor(name)));
      try {
        const results = await Promise.all(pools.map((p) => migrate(p)));
        expect(results.filter((r) => r.length === 1)).toHaveLength(1);
        expect(results.filter((r) => r.length === 0)).toHaveLength(5);
        expect((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n).toBe(1);
      } finally {
        await Promise.all(pools.map((p) => p.end()));
      }
    });
  });

  describe('a database an earlier version created', () => {
    const fixtures = readdirSync(FIXTURES)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    it('has the fixtures it needs', () => {
      expect(fixtures.length).toBeGreaterThanOrEqual(4);
    });

    it.each(fixtures)('keeps its data and ends with exactly the schema of a new database (%s)', async (file) => {
      // The database as that version left it, with a customer, an order, a conversation and a run in it.
      await pool.query(readFileSync(join(FIXTURES, file), 'utf8'));
      await pool.query(`INSERT INTO customers (name, email) VALUES ('Ava', 'ava@example.com')`);
      await pool.query(`INSERT INTO orders (customer_id, status, total, items) VALUES (1, 'delivered', 50, '[]')`);
      await pool.query(`INSERT INTO conversations (customer_id, title) VALUES (1, 'old chat')`);
      await pool.query(`INSERT INTO runs (conversation_id, status) SELECT id, 'completed' FROM conversations`);

      expect(await migrate(pool)).toEqual([1]);

      expect((await pool.query('SELECT count(*)::int AS n FROM customers')).rows[0].n).toBe(1);
      expect((await pool.query('SELECT status, total FROM orders')).rows).toEqual([{ status: 'delivered', total: 50 }]);
      expect((await pool.query('SELECT status FROM runs')).rows).toEqual([{ status: 'completed' }]);

      // Same schema as a database created today.
      const fresh = `mig_${randomBytes(5).toString('hex')}_test`;
      await admin.query(`CREATE DATABASE "${fresh}"`);
      const freshPool = createPool(urlFor(fresh));
      try {
        await migrate(freshPool);
        expect(await schemaDump(pool)).toEqual(await schemaDump(freshPool));
      } finally {
        await freshPool.end();
        await dropDatabase(fresh);
      }
    });
  });

  describe('safety', () => {
    it('refuses to start when an applied migration was edited', async () => {
      await migrate(pool);
      await pool.query(`UPDATE schema_migrations SET checksum = 'edited' WHERE version = 1`);
      await expect(migrate(pool)).rejects.toThrow('was changed after it was applied');
    });

    it('rolls a failing migration back completely and leaves the database where it was', async () => {
      const broken: Migration = { version: 2, name: 'broken', sql: 'CREATE TABLE half_done (id int); SELECT 1/0;' };
      await migrate(pool);
      await expect(migrate(pool, [...MIGRATIONS, broken])).rejects.toThrow(/Migration 2 \(broken\) failed and was rolled back/);
      expect((await pool.query(`SELECT to_regclass('half_done') AS t`)).rows[0].t).toBeNull();
      expect((await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows).toEqual([{ version: 1 }]);
    });

    it('commits a migration and its bookkeeping row together: if recording fails, the migration is undone too', async () => {
      await migrate(pool);
      await pool.query(`CREATE FUNCTION refuse_v2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cannot record'; END $$`);
      await pool.query(
        `CREATE TRIGGER refuse_v2 BEFORE INSERT ON schema_migrations FOR EACH ROW WHEN (NEW.version = 2) EXECUTE FUNCTION refuse_v2()`,
      );
      const next: Migration = { version: 2, name: 'tracked-together', sql: 'CREATE TABLE tracked_together (id int)' };
      await expect(migrate(pool, [...MIGRATIONS, next])).rejects.toThrow(/Migration 2 \(tracked-together\) failed and was rolled back/);
      // Otherwise the table would exist while the history says it does not, and the next start would try to create it again.
      expect((await pool.query(`SELECT to_regclass('tracked_together') AS t`)).rows[0].t).toBeNull();
    });

    it('applies a later migration after a failed one is fixed', async () => {
      await migrate(pool);
      const fixed: Migration = { version: 2, name: 'add-note', sql: 'CREATE TABLE note (id int)' };
      expect(await migrate(pool, [...MIGRATIONS, fixed])).toEqual([2]);
      expect((await pool.query(`SELECT to_regclass('note') AS t`)).rows[0].t).toBe('note');
    });

    it('warns, and carries on, when the database was migrated by a newer version', async () => {
      await migrate(pool);
      await pool.query(`INSERT INTO schema_migrations (version, name, checksum) VALUES (99, 'from-the-future', 'x')`);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      expect(await migrate(pool)).toEqual([]);
      expect(String(warn.mock.calls[0]?.[0])).toContain('99');
    });
  });

  describe('checking without changing', () => {
    it('lists everything as pending on a database that was never migrated, and changes nothing', async () => {
      expect((await pendingMigrations(pool)).map((x) => x.version)).toEqual([1]);
      expect((await pool.query(`SELECT to_regclass('schema_migrations') AS t`)).rows[0].t).toBeNull();
      await expect(assertUpToDate(pool)).rejects.toThrow(/missing migration\(s\) 1 \(baseline\)/);
    });

    it('is satisfied once migrated, and notices a newer migration', async () => {
      await migrate(pool);
      await expect(assertUpToDate(pool)).resolves.toBeUndefined();
      const next: Migration = { version: 2, name: 'next', sql: 'SELECT 1' };
      await expect(assertUpToDate(pool, [...MIGRATIONS, next])).rejects.toThrow('2 (next)');
    });
  });

  describe('the API at start-up', () => {
    const boot = async (env: Record<string, string>) => {
      const saved = { ...process.env };
      Object.assign(process.env, { DATABASE_URL: urlFor(name), LLM_PROVIDER: 'mock', ...env });
      try {
        const app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
        try {
          await app.init();
        } catch (e) {
          await app.close(); // releases the pool the failed start-up opened
          throw e;
        }
        return app;
      } finally {
        process.env = saved;
      }
    };

    it('migrates a new database itself by default', async () => {
      const app = await boot({});
      await app.close();
      expect((await pool.query('SELECT version FROM schema_migrations')).rows).toEqual([{ version: 1 }]);
    });

    it('with MIGRATE_ON_BOOT=false, refuses to start on a database that is behind, without touching it', async () => {
      await expect(boot({ MIGRATE_ON_BOOT: 'false' })).rejects.toThrow(/missing migration\(s\) 1/);
      expect((await pool.query(`SELECT to_regclass('customers') AS t`)).rows[0].t).toBeNull();
    });

    it('with MIGRATE_ON_BOOT=false, starts on a database that is up to date', async () => {
      await migrate(pool);
      const app = await boot({ MIGRATE_ON_BOOT: 'false' });
      await app.close();
    });
  });

  describe('resetting data', () => {
    it('RESET_SQL names every table except the migration history', async () => {
      await migrate(pool);
      const tables = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map(
        (r) => r.table_name as string,
      );
      const listed = RESET_SQL.replace(/^TRUNCATE\s+/, '')
        .replace(/\s+RESTART.*$/, '')
        .split(/,\s*/);
      expect(tables.filter((t) => t !== 'schema_migrations' && !listed.includes(t))).toEqual([]);
      expect(listed.filter((t) => !tables.includes(t))).toEqual([]);
      expect(listed).not.toContain('schema_migrations');
    });

    it('seeding keeps the migration history', async () => {
      await seedDatabase(pool);
      await seedDatabase(pool);
      expect((await pool.query('SELECT version FROM schema_migrations')).rows).toEqual([{ version: 1 }]);
    });
  });
});
