import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Pool } from 'pg';
import { AuthService } from '../auth/auth.service';
import type { AppConfig } from '../config';
import { APP_CONFIG, PG_POOL } from '../tokens';

@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool, @Inject(APP_CONFIG) private readonly cfg: AppConfig, private readonly auth: AuthService) {}

  @Get()
  async check() {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down', provider: this.cfg.provider });
    }
    const reviewerAccounts = await this.auth.isAccountsMode();
    return { status: 'ok', db: 'up', provider: this.cfg.provider, reviewerAuth: Boolean(this.cfg.reviewerApiKey) || reviewerAccounts, reviewerAccounts };
  }
}
