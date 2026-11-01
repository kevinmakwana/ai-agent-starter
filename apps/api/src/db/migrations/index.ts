import { BASELINE_SQL } from './0001-baseline';

export interface Migration {
  /** 1, 2, 3, ... with no gaps. */
  version: number;
  name: string;
  sql: string;
}

/**
 * Append only. Rules (README, "Database migrations"):
 * - never edit or reorder a migration that has been released (its checksum is verified at startup);
 * - each one runs in a single transaction, so do not use CREATE INDEX CONCURRENTLY or other statements that cannot;
 * - keep each one compatible with the previous application version (add first, remove in a later release), because during a
 *   rolling deploy the old version still runs against the new schema.
 */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'baseline', sql: BASELINE_SQL }];
