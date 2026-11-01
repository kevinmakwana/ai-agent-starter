import { Global, Inject, Injectable, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { loadConfig } from '../config';
import { APP_CONFIG, PG_POOL } from '../tokens';
import { PgReviewerStore } from '../auth/pg-reviewer.store';
import { PgCustomerAuthStore } from '../auth/pg-customer.store';
import { CUSTOMER_AUTH_STORE, REVIEWER_STORE } from '../auth/tokens';
import { PgAgentStore } from './pg-agent.store';
import { PgShopRepo } from './pg-shop.repo';
import { assertUpToDate, migrate } from './migrate';
import { createPool } from './pool';

@Injectable()
class DatabaseLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly cfg: ReturnType<typeof loadConfig>,
  ) {}
  async onModuleInit() {
    // Deployments that migrate as a separate step set MIGRATE_ON_BOOT=false: the API then only checks, and refuses to start behind.
    if (this.cfg.migrateOnBoot) await migrate(this.pool);
    else await assertUpToDate(this.pool);
  }
  onApplicationShutdown() {
    return this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: PG_POOL, inject: [APP_CONFIG], useFactory: (cfg: ReturnType<typeof loadConfig>) => createPool(cfg.databaseUrl) },
    { provide: PgShopRepo, inject: [PG_POOL], useFactory: (pool: Pool) => new PgShopRepo(pool) },
    { provide: PgAgentStore, inject: [PG_POOL], useFactory: (pool: Pool) => new PgAgentStore(pool) },
    { provide: REVIEWER_STORE, inject: [PG_POOL], useFactory: (pool: Pool) => new PgReviewerStore(pool) },
    { provide: CUSTOMER_AUTH_STORE, inject: [PG_POOL], useFactory: (pool: Pool) => new PgCustomerAuthStore(pool) },
    DatabaseLifecycle,
  ],
  exports: [APP_CONFIG, PG_POOL, PgShopRepo, PgAgentStore, REVIEWER_STORE, CUSTOMER_AUTH_STORE],
})
export class DatabaseModule {}
