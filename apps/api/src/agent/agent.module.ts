import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { AppConfig } from '../config';
import { PgAgentStore } from '../db/pg-agent.store';
import { PgShopRepo } from '../db/pg-shop.repo';
import { ApprovalsController } from '../http/approvals.controller';
import { ConversationsController } from '../http/conversations.controller';
import { DomainErrorFilter } from '../http/domain-error.filter';
import { HealthController } from '../http/health.controller';
import { createProvider } from '../providers';
import { APP_CONFIG, CHAT_PROVIDER } from '../tokens';
import { AgentRunner } from './runner';
import type { ChatProvider } from './types';

@Module({
  controllers: [HealthController, ConversationsController, ApprovalsController],
  providers: [
    { provide: CHAT_PROVIDER, inject: [APP_CONFIG], useFactory: (cfg: AppConfig) => createProvider(cfg) },
    {
      provide: AgentRunner,
      inject: [CHAT_PROVIDER, PgShopRepo, PgAgentStore, APP_CONFIG],
      useFactory: (provider: ChatProvider, shop: PgShopRepo, store: PgAgentStore, cfg: AppConfig) =>
        new AgentRunner({ provider, shop, store, maxSteps: cfg.maxSteps }),
    },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
export class AgentModule {}
