import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../tokens';
import { ApprovalExpiry } from './approval-expiry';

const SWEEP_EVERY_MS = 60_000;

/**
 * Once a minute while the API is up: auto-reject stale approvals and finish decisions a crashed process left half-done.
 * Single-instance: no cross-instance coordination.
 */
@Injectable()
export class ApprovalExpiryScheduler implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('ApprovalExpiry');
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(private readonly expiry: ApprovalExpiry, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), SWEEP_EVERY_MS);
    this.timer.unref(); // never keeps the process (or a test run) alive
  }

  /** Never overlaps itself: each rejection or recovery resumes a run (a model call), so a slow pass must not pile up. */
  private async tick() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const { expired } = await this.expiry.sweep(); // no-op when APPROVAL_TTL_MINUTES=0
      if (expired) this.logger.log(`Auto-rejected ${expired} approval(s) with no decision in ${this.cfg.approvalTtlMinutes} min`);
    } catch (e) {
      this.logger.error(`Approval sweep failed: ${e instanceof Error ? e.message : e}`);
    }
    try {
      const { recovered } = await this.expiry.recoverStranded();
      if (recovered) this.logger.warn(`Finished ${recovered} approval decision(s) interrupted by a restart`);
    } catch (e) {
      this.logger.error(`Approval recovery failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.sweeping = false;
    }
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }
}
