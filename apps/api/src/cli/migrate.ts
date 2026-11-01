import { loadConfig, loadRootEnv } from '../config';
import { migrate, pendingMigrations } from '../db/migrate';
import { createPool } from '../db/pool';

// npm run migrate -w apps/api            applies every pending migration
// npm run migrate -w apps/api -- --status  lists the pending ones and changes nothing (exit 1 if there are any)
async function main() {
  loadRootEnv();
  const status = process.argv.includes('--status');
  const pool = createPool(loadConfig().databaseUrl);
  try {
    if (status) {
      const pending = await pendingMigrations(pool);
      console.log(pending.length ? `Pending: ${pending.map((m) => `${m.version} ${m.name}`).join(', ')}` : 'The database is up to date.');
      process.exitCode = pending.length ? 1 : 0;
      return;
    }
    const applied = await migrate(pool);
    console.log(applied.length ? `Applied migration(s): ${applied.join(', ')}` : 'The database is up to date.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`Migration failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
