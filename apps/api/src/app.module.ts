import { Module } from '@nestjs/common';
import { AgentModule } from './agent/agent.module';
import { DatabaseModule } from './db/database.module';

@Module({ imports: [DatabaseModule, AgentModule] })
export class AppModule {}
