import { loadConfig, loadRootEnv } from '../config';
import { createPool } from './pool';
import { seedDatabase, TOTAL_CUSTOMERS, TOTAL_ORDERS } from './seed-data';

async function main() {
  loadRootEnv();
  const pool = createPool(loadConfig().databaseUrl);
  try {
    await seedDatabase(pool);
    console.log(`Seeded ${TOTAL_CUSTOMERS} customers and ${TOTAL_ORDERS} orders.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`Seed failed: ${err.message}\nIs Postgres running? Try: npm run db:up`);
  process.exit(1);
});
