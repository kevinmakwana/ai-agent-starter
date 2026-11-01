import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { MIGRATIONS, type Migration } from './migrations';

const log = new Logger('Migrations');

/** One session-level advisory lock serializes every process that migrates the same database (replicas booting together). */
const LOCK_KEY = "hashtext('ai-agent-starter:migrations')";
/** Waiting for another process to finish, and waiting for a table lock held by live traffic, both end in an error, not a hang. */
const LOCK_WAIT = '60s';
const DDL_LOCK_WAIT = '30s';

export const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

export interface Plan {
  pending: Migration[];
  /** Versions recorded in the database that this build does not know: the database was migrated by a newer version. */
  unknown: number[];
}

/** Checks the recorded history against the known migrations. Pure, so it can be tested without a database. */
export function planMigrations(applied: readonly AppliedMigration[], known: readonly Migration[] = MIGRATIONS): Plan {
  const byVersion = new Map(known.map((m) => [m.version, m]));
  const appliedVersions = new Set(applied.map((a) => a.version));
  const unknown: number[] = [];
  for (const row of applied) {
    const migration = byVersion.get(row.version);
    if (!migration) {
      unknown.push(row.version);
      continue;
    }
    if (migration.name !== row.name || checksum(migration.sql) !== row.checksum) {
      throw new Error(
        `Migration ${row.version} (${row.name}) was changed after it was applied to this database. ` +
          'Released migrations are never edited; add a new migration instead.',
      );
    }
  }
  const pending = known.filter((m) => !appliedVersions.has(m.version)).sort((a, b) => a.version - b.version);
  // A hole in the history (1 and 3 applied, 2 missing) means the database is not in a state this code can reason about.
  const highestApplied = Math.max(0, ...appliedVersions);
  const gap = pending.find((m) => m.version < highestApplied);
  if (gap) {
    throw new Error(`Migration ${gap.version} (${gap.name}) is missing from this database although a later one is recorded.`);
  }
  return { pending, unknown };
}

/** Throws unless the list is 1..n with no gaps, no duplicates and a name that is a plain slug. */
export function assertValidMigrationList(list: readonly Migration[]): void {
  list.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migrations must be numbered 1..n in order: position ${i + 1} has version ${m.version}`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(m.name)) throw new Error(`Migration ${m.version} has an invalid name "${m.name}"`);
    if (!m.sql.trim()) throw new Error(`Migration ${m.version} (${m.name}) is empty`);
  });
}

async function readApplied(db: Pick<PoolClient, 'query'>): Promise<AppliedMigration[]> {
  const { rows } = await db.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  return rows.map((r) => ({ version: Number(r.version), name: String(r.name), checksum: String(r.checksum) }));
}

const CREATE_TRACKING_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version int PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/** Runs `work` while holding the migration lock on a dedicated connection; the lock is released even if `work` throws. */
async function withLock<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`SET lock_timeout = '${LOCK_WAIT}'`);
    await client.query(`SELECT pg_advisory_lock(${LOCK_KEY})`);
    try {
      await client.query('RESET lock_timeout');
      return await work(client);
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/**
 * Applies every pending migration, each in its own transaction, under a database-wide lock. Safe to call from several
 * processes at once: one applies, the others wait and then find nothing to do. Returns the versions it applied.
 */
export async function migrate(pool: Pool, known: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  assertValidMigrationList(known);
  return withLock(pool, async (client) => {
    await client.query(CREATE_TRACKING_TABLE);
    const { pending, unknown } = planMigrations(await readApplied(client), known);
    if (unknown.length) {
      log.warn(
        `The database records migration(s) ${unknown.join(', ')} that this version does not know: it was migrated by a newer version. ` +
          'Continuing is only safe if those migrations are compatible with this code.',
      );
    }
    const applied: number[] = [];
    for (const m of pending) {
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '${DDL_LOCK_WAIT}'`);
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          m.version,
          m.name,
          checksum(m.sql),
        ]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${m.version} (${m.name}) failed and was rolled back: ${e instanceof Error ? e.message : String(e)}`, {
          cause: e,
        });
      }
      log.log(`Applied migration ${m.version} (${m.name})`);
      applied.push(m.version);
    }
    return applied;
  });
}

/** What `migrate` would apply, without changing anything. A database that was never migrated has every migration pending. */
export async function pendingMigrations(pool: Pool, known: readonly Migration[] = MIGRATIONS): Promise<Migration[]> {
  const { rows } = await pool.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS present");
  const applied = rows[0]?.present ? await readApplied(pool) : [];
  return planMigrations(applied, known).pending;
}

/** For deployments that migrate in a separate step: refuse to start against a schema that is behind this code. */
export async function assertUpToDate(pool: Pool, known: readonly Migration[] = MIGRATIONS): Promise<void> {
  const pending = await pendingMigrations(pool, known);
  if (pending.length) {
    throw new Error(
      `The database is missing migration(s) ${pending.map((m) => `${m.version} (${m.name})`).join(', ')}. ` +
        'Run `npm run migrate -w apps/api` (or `node dist/cli/migrate.js`) first, or set MIGRATE_ON_BOOT=true.',
    );
  }
}
