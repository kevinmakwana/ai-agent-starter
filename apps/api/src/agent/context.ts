import { systemPrompt } from './prompt';
import type { ChatMessage, Conversation, Step, ToolCall } from './types';

/** Rough token estimate (about 4 characters per token); good enough to size a window, not to bill. */
const estimate = (m: ChatMessage) => Math.ceil((m.content.length + JSON.stringify(m.toolCalls ?? []).length) / 4) + 4;

/** A turn is one user message plus everything the agent did in answer to it. */
function splitTurns(steps: Step[]): Step[][] {
  const turns: Step[][] = [];
  for (const s of steps) {
    if (s.role === 'user' || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(s);
  }
  return turns;
}

function toMessages(steps: Step[], answered: Set<string | null>): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const s of steps) {
    if (s.role === 'user') messages.push({ role: 'user', content: s.content ?? '' });
    else if (s.role === 'tool') messages.push({ role: 'tool', toolCallId: s.toolCallId!, content: JSON.stringify(s.result) });
    else if (s.toolName && s.toolCallId) {
      if (!answered.has(s.toolCallId)) continue; // dangling call from a crashed run: keep history valid
      const call: ToolCall = { id: s.toolCallId, name: s.toolName, args: s.toolArgs };
      const prev = messages[messages.length - 1];
      if (prev?.role === 'assistant' && prev.toolCalls) {
        prev.toolCalls.push(call);
        prev.content ||= s.content ?? '';
      } else messages.push({ role: 'assistant', content: s.content ?? '', toolCalls: [call] });
    } else messages.push({ role: 'assistant', content: s.content ?? '' });
  }
  return messages;
}

/**
 * Rebuilds provider messages from persisted steps (so a paused run can resume after a restart).
 * With `maxTokens`, whole old turns are dropped, oldest first, so a tool result is never separated from its
 * call; the current turn is always kept. The stored trace is untouched: only what the model sees shrinks.
 */
export function buildMessages(
  conv: Pick<Conversation, 'customerName' | 'customerEmail'>,
  steps: Step[],
  maxTokens = Infinity,
): ChatMessage[] {
  const answered = new Set(steps.filter((s) => s.role === 'tool').map((s) => s.toolCallId));
  const turns = splitTurns(steps).map((t) => toMessages(t, answered));
  const system = systemPrompt(conv);

  let used = estimate({ role: 'system', content: system });
  let keepFrom = turns.length;
  while (keepFrom > 0) {
    const cost = turns[keepFrom - 1].reduce((n, m) => n + estimate(m), 0);
    if (keepFrom < turns.length && used + cost > maxTokens) break; // the newest turn is always kept
    used += cost;
    keepFrom--;
  }

  const omitted = keepFrom;
  const note = omitted
    ? `\nNote: ${omitted} earlier message${omitted === 1 ? ' was' : 's were'} left out of this conversation to save space.`
    : '';
  return [{ role: 'system', content: system + note }, ...turns.slice(keepFrom).flat()];
}
