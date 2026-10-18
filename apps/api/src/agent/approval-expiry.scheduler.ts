import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../tokens';
import { ApprovalExpiry } from './approval-expiry';

const SWEEP_EVERY_MS = 60_000;

/** Runs ApprovalExpiry.sweep() once a minute while the API is up. Single-instance: no cross-instance coordination. */
@Injectable()
export class ApprovalExpiryScheduler implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('ApprovalExpiry');
  private timer?: NodeJS.Timeout;

  constructor(private readonly expiry: ApprovalExpiry, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  onModuleInit() {
    if (this.cfg.approvalTtlMinutes <= 0) return;
    this.timer = setInterval(() => {
      this.expiry.sweep().then(
        ({ expired }) => { if (expired) this.logger.log(`Auto-rejected ${expired} approval(s) with no decision in ${this.cfg.approvalTtlMinutes} min`); },
        (e) => this.logger.error(`Approval sweep failed: ${e instanceof Error ? e.message : e}`),
      );
    }, SWEEP_EVERY_MS);
    this.timer.unref(); // never keeps the process (or a test run) alive
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }
}
