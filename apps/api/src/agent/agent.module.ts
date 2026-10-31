import { Logger, type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthService } from '../auth/auth.service';
import { CustomerAuthService } from '../auth/customer-auth.service';
import { createLoginMailer, type LoginMailer } from '../auth/login-mailer';
import { LOGIN_MAILER } from '../auth/tokens';
import { PrincipalMiddleware } from '../auth/principal.middleware';
import type { AppConfig } from '../config';
import { PgAgentStore } from '../db/pg-agent.store';
import { PgShopRepo } from '../db/pg-shop.repo';
import { StreamBus, pgListenConnection } from '../events/stream-bus';
import { AuthController } from '../http/auth.controller';
import { ApprovalsController } from '../http/approvals.controller';
import { ConversationsController } from '../http/conversations.controller';
import { DomainErrorFilter } from '../http/domain-error.filter';
import { EventsController } from '../http/events.controller';
import { HealthController } from '../http/health.controller';
import { ReviewersController } from '../http/reviewers.controller';
import { NotifierLifecycle } from '../notify/notifier.lifecycle';
import { createProvider } from '../providers';
import { APP_CONFIG, CHAT_PROVIDER } from '../tokens';
import { ApprovalExpiry } from './approval-expiry';
import { ApprovalExpiryScheduler } from './approval-expiry.scheduler';
import { AgentRunner } from './runner';
import type { ChatProvider } from './types';

@Module({
  controllers: [HealthController, ConversationsController, ApprovalsController, EventsController, AuthController, ReviewersController],
  providers: [
    { provide: CHAT_PROVIDER, inject: [APP_CONFIG], useFactory: (cfg: AppConfig) => createProvider(cfg) },
    {
      provide: AgentRunner,
      inject: [CHAT_PROVIDER, PgShopRepo, PgAgentStore, APP_CONFIG],
      useFactory: (provider: ChatProvider, shop: PgShopRepo, store: PgAgentStore, cfg: AppConfig) =>
        new AgentRunner({ provider, shop, store, maxSteps: cfg.maxSteps, tokenBudget: cfg.conversationTokenBudget,
          maxContextTokens: cfg.contextMaxTokens, approvalPolicy: cfg.approvalPolicy }),
    },
    {
      provide: ApprovalExpiry,
      inject: [AgentRunner, PgAgentStore, APP_CONFIG],
      useFactory: (runner: AgentRunner, store: PgAgentStore, cfg: AppConfig) =>
        new ApprovalExpiry({
          store, runner, ttlMs: cfg.approvalTtlMinutes * 60_000,
          onError: (id, e) => new Logger('ApprovalExpiry').error(`Could not expire approval ${id}: ${e instanceof Error ? e.message : e}`),
        }),
    },
    ApprovalExpiryScheduler,
    AuthService,
    {
      provide: LOGIN_MAILER,
      inject: [APP_CONFIG],
      // null when login is off: nothing can send mail, and no SMTP settings are needed
      useFactory: (cfg: AppConfig): LoginMailer | null =>
        cfg.customerLogin.enabled && cfg.customerLogin.mail ? createLoginMailer(cfg.customerLogin.mail) : null,
    },
    CustomerAuthService,
    NotifierLifecycle,
    {
      provide: StreamBus,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) =>
        new StreamBus({
          connect: () => pgListenConnection(cfg.databaseUrl),
          onError: (e) => new Logger('StreamBus').warn(`Live-update listener: ${e instanceof Error ? e.message : e}`),
        }),
    },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
export class AgentModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // every route, so guards, controllers and SSE streams share one principal per request
    consumer.apply(PrincipalMiddleware).forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
