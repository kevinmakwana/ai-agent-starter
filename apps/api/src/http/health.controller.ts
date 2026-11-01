import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Pool } from 'pg';
import { AuthService } from '../auth/auth.service';
import type { AppConfig } from '../config';
import { APP_CONFIG, PG_POOL } from '../tokens';

@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly auth: AuthService,
  ) {}

  /** Liveness: the process is up and serving. Deliberately touches nothing else, so a database outage never gets the process restarted. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: the API can do its job, which needs the database. 503 while it cannot, so a balancer stops sending traffic. */
  @Get('ready')
  async ready() {
    await this.assertDatabase();
    return { status: 'ok', db: 'up' };
  }

  /** The original combined endpoint, unchanged (the web app reads the mode flags from it): readiness plus configuration facts. */
  @Get()
  async check() {
    await this.assertDatabase();
    const reviewerAccounts = await this.auth.isAccountsMode();
    return {
      status: 'ok',
      db: 'up',
      provider: this.cfg.provider,
      reviewerAuth: Boolean(this.cfg.reviewerApiKey) || reviewerAccounts,
      reviewerAccounts,
      customerLogin: this.cfg.customerLogin.enabled,
    };
  }

  private async assertDatabase() {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down', provider: this.cfg.provider });
    }
  }
}
