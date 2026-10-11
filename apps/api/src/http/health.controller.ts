import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import type { AppConfig } from '../config';
import { APP_CONFIG, PG_POOL } from '../tokens';

@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  @Get()
  async check() {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down', provider: this.cfg.provider });
    }
    return { status: 'ok', db: 'up', provider: this.cfg.provider, reviewerAuth: Boolean(this.cfg.reviewerApiKey) };
  }
}
