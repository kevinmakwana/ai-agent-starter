import { Pool, types } from 'pg';
import { SCHEMA_SQL } from './schema';

// numeric -> number, bigint -> number, timestamptz -> ISO string (all values here are small / safe).
types.setTypeParser(1700, (v) => parseFloat(v));
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1184, (v) => new Date(v).toISOString());

export const createPool = (connectionString: string) => new Pool({ connectionString, max: 10 });

export const ensureSchema = (pool: Pool) => pool.query(SCHEMA_SQL);

/** snake_case row -> camelCase object. */
export function camel<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]),
  ) as T;
}
