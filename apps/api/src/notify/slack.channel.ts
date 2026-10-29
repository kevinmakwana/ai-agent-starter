import { slackText } from './format';
import { postJson } from './http-post';
import type { ApprovalNote, Channel } from './types';

/** Slack incoming webhook: one text line per approval. */
export function slackChannel({ url, fetchFn = fetch }: { url: string; fetchFn?: typeof fetch }): Channel {
  return {
    name: 'slack',
    send(note: ApprovalNote, signal: AbortSignal): Promise<void> {
      const body = JSON.stringify({ text: slackText(note) });
      return postJson(fetchFn, url, { headers: { 'content-type': 'application/json' }, body, signal });
    },
  };
}
