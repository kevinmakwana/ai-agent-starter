import { Logger } from '@nestjs/common';
import { Pool, types } from 'pg';

// numeric -> number, bigint -> number, timestamptz -> ISO string (all values here are small / safe).
types.setTypeParser(1700, (v) => parseFloat(v));
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1184, (v) => new Date(v).toISOString());

const log = new Logger('Database');

export function createPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString, max: 10 });
  // The server can end a connection that sits idle in the pool (a restart, a failover, an admin kill). pg reports that as an
  // 'error' event, and with no listener Node treats it as an uncaught exception and the whole API exits. The pool already drops
  // the dead client and opens a new one on the next query, so all that is needed is to say so. Only the message is logged.
  pool.on('error', (e) => log.warn(`An idle database connection was lost and will be replaced: ${e.message}`));
  return pool;
}

/** snake_case row -> camelCase object. */
export function camel<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v])) as T;
}
