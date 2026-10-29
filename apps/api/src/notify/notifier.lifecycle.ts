import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { AppConfig } from '../config';
import { PgAgentStore } from '../db/pg-agent.store';
import { StreamBus } from '../events/stream-bus';
import { APP_CONFIG } from '../tokens';
import { createChannels } from './create-channels';
import { Notifier } from './notifier';
import { notifyEnabled } from './notify-config';

/**
 * Runs the Notifier while the API is up, when at least one channel is configured. With none configured nothing
 * starts and nothing is claimed.
 * Stops in `beforeApplicationShutdown`, ahead of the pool closing (which happens in `onApplicationShutdown`), so a pass
 * in flight can still release the rows it did not get to.
 */
@Injectable()
export class NotifierLifecycle implements OnModuleInit, BeforeApplicationShutdown {
  private notifier?: Notifier;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly store: PgAgentStore,
    private readonly bus: StreamBus,
  ) {}

  onModuleInit() {
    if (!notifyEnabled(this.cfg.notify)) return;
    const logger = new Logger('Notifier');
    this.notifier = new Notifier({
      store: { claimUnnotified: (n) => this.store.claimUnnotified(n), release: (ids) => this.store.releaseClaims(ids) },
      channels: createChannels(this.cfg.notify),
      consoleUrl: this.cfg.notify.consoleUrl,
      log: { warn: (m) => logger.warn(m) },
    });
    this.notifier.start(this.bus);
  }

  async beforeApplicationShutdown() {
    await this.notifier?.stop();
  }
}
