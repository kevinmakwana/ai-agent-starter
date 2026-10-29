import { createHmac } from 'node:crypto';
import { postJson } from './http-post';
import type { ApprovalNote, Channel } from './types';

export interface WebhookOptions {
  url: string;
  secret?: string;
  fetchFn?: typeof fetch;
  nowSec?: () => number;
}

/** Generic JSON webhook. With a secret the body is signed as HMAC-SHA256 over `<timestamp>.<body>`. */
export function webhookChannel({ url, secret, fetchFn = fetch, nowSec = () => Math.floor(Date.now() / 1000) }: WebhookOptions): Channel {
  return {
    name: 'webhook',
    send(note: ApprovalNote, signal: AbortSignal): Promise<void> {
      const body = JSON.stringify({ event: 'approval.requested', approval: note });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (secret) {
        const timestamp = String(nowSec());
        headers['x-timestamp'] = timestamp;
        headers['x-signature'] = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
      }
      return postJson(fetchFn, url, { headers, body, signal });
    },
  };
}
