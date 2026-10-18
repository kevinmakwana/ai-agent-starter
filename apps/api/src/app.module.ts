import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { seconds, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AgentModule } from './agent/agent.module';
import type { AppConfig } from './config';
import { DatabaseModule } from './db/database.module';
import { APP_CONFIG } from './tokens';

@Module({
  imports: [
    DatabaseModule,
    AgentModule,
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => [{ ttl: seconds(60), limit: cfg.rateLimit.perMinute }],
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
