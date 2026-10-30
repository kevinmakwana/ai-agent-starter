import { Global, Inject, Injectable, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { loadConfig } from '../config';
import { APP_CONFIG, PG_POOL } from '../tokens';
import { PgReviewerStore } from '../auth/pg-reviewer.store';
import { REVIEWER_STORE } from '../auth/tokens';
import { PgAgentStore } from './pg-agent.store';
import { PgShopRepo } from './pg-shop.repo';
import { createPool, ensureSchema } from './pool';

@Injectable()
class DatabaseLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  onModuleInit() { return ensureSchema(this.pool); }
  onApplicationShutdown() { return this.pool.end(); }
}

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: PG_POOL, inject: [APP_CONFIG], useFactory: (cfg: ReturnType<typeof loadConfig>) => createPool(cfg.databaseUrl) },
    { provide: PgShopRepo, inject: [PG_POOL], useFactory: (pool: Pool) => new PgShopRepo(pool) },
    { provide: PgAgentStore, inject: [PG_POOL], useFactory: (pool: Pool) => new PgAgentStore(pool) },
    { provide: REVIEWER_STORE, inject: [PG_POOL], useFactory: (pool: Pool) => new PgReviewerStore(pool) },
    DatabaseLifecycle,
  ],
  exports: [APP_CONFIG, PG_POOL, PgShopRepo, PgAgentStore, REVIEWER_STORE],
})
export class DatabaseModule {}
