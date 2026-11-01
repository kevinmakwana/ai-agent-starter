import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig, loadRootEnv } from './config';
import { configureApp } from './http/setup';
import { StructuredLogger } from './logging/structured-logger';

async function bootstrap() {
  loadRootEnv();
  const cfg = loadConfig();
  const app = await NestFactory.create(AppModule, { logger: new StructuredLogger(cfg.logFormat) });
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(cfg.port);
  new Logger('Bootstrap').log(`API on http://localhost:${cfg.port} (LLM provider: ${cfg.provider})`);
}

bootstrap().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
