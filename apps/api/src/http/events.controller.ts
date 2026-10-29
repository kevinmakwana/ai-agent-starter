import { Controller, Inject, ParseUUIDPipe, Param, Sse, UseGuards } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { AppConfig } from '../config';
import { eventStream } from '../events/event-stream';
import { StreamBus } from '../events/stream-bus';
import { StreamLimiter } from '../events/stream-limiter';
import { APP_CONFIG } from '../tokens';
import { ConversationAccessGuard } from './conversation-access.guard';
import { ReviewerGuard } from './reviewer.guard';

/** Idle proxies drop quiet connections; a comment this often keeps them open. */
export const STREAM_PING_MS = 15_000;

/**
 * Live-update signals (never content): clients refetch the normal GET endpoints when one arrives, so the
 * customer/reviewer filtering stays in those endpoints. Auth runs in the guards, before any stream opens.
 */
@Controller()
export class EventsController {
  private readonly limiter = new StreamLimiter();

  constructor(private readonly bus: StreamBus, @Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** A customer (or reviewer) watching one conversation: only that conversation's `trace` changes. */
  @Sse('conversations/:id/events')
  @UseGuards(ConversationAccessGuard)
  conversation(@Param('id', ParseUUIDPipe) id: string): Observable<MessageEvent> {
    // UUIDs are case-insensitive but these comparisons are not: the cap and the filter use Postgres's lowercase form.
    const key = id.toLowerCase();
    return eventStream({
      bus: this.bus, limiter: this.limiter, key, max: this.cfg.streams.perConversation, pingMs: STREAM_PING_MS,
      accept: (e) => e.kind === 'trace' && e.conversationId === key,
    });
  }

  /** The reviewer console: every conversation's `trace`, `approvals` and `audit` changes. */
  @Sse('events')
  @UseGuards(ReviewerGuard)
  all(): Observable<MessageEvent> {
    return eventStream({
      bus: this.bus, limiter: this.limiter, key: '*reviewer', max: this.cfg.streams.reviewer, pingMs: STREAM_PING_MS,
      accept: () => true,
    });
  }
}
