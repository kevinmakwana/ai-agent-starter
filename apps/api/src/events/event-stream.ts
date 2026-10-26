import { HttpException, HttpStatus, type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { AgentEvent } from './agent-events';
import type { StreamBus } from './stream-bus';
import type { StreamLimiter } from './stream-limiter';

export interface EventStreamOptions {
  bus: StreamBus;
  limiter: StreamLimiter;
  /** What the cap counts: a conversation id, or one shared key for the reviewer stream. */
  key: string;
  max: number;
  /** Which signals this caller may see. `resync` always passes. */
  accept: (e: AgentEvent) => boolean;
  pingMs: number;
}

/**
 * The SSE body. The slot is taken when the response is subscribed (so a request that never gets that far leaks
 * nothing) and given back with the listener and timer when the client goes away.
 */
export function eventStream(o: EventStreamOptions): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    const release = o.limiter.acquire(o.key, o.max);
    if (!release) {
      subscriber.error(new HttpException('Too many open streams; close one and retry.', HttpStatus.TOO_MANY_REQUESTS));
      return undefined;
    }
    // Nest holds the response headers back until the first message, so say something straight away.
    subscriber.next({ comment: 'connected' });
    const unsubscribe = o.bus.subscribe((e) => {
      if (e.kind === 'resync') subscriber.next({ type: 'resync', data: {} });
      else if (o.accept(e)) subscriber.next({ type: e.kind, data: { conversationId: e.conversationId } });
    });
    const ping = setInterval(() => subscriber.next({ comment: 'ping' }), o.pingMs);
    // On app shutdown, end the response so the HTTP server can close; teardown below still runs.
    const stopClosing = o.bus.onClosing(() => subscriber.complete());
    return () => {
      clearInterval(ping);
      stopClosing();
      unsubscribe();
      release();
    };
  });
}
