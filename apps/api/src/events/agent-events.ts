/** Postgres channel the store notifies and StreamBus listens on. */
export const AGENT_EVENTS_CHANNEL = 'agent_events';

export type AgentEventKind = 'trace' | 'approvals' | 'audit';

/** `resync` is synthetic: StreamBus emits it after a lost connection, since events may have been missed. */
export type AgentEvent = { kind: AgentEventKind; conversationId: string } | { kind: 'resync' };

const KINDS: readonly string[] = ['trace', 'approvals', 'audit'];

export const encodeEvent = (kind: AgentEventKind, conversationId: string): string =>
  JSON.stringify({ kind, conversationId });

/** Anything malformed (or unknown) is dropped rather than thrown: a bad NOTIFY must never break the listener. */
export function parseEvent(payload: string | undefined): AgentEvent | null {
  if (!payload) return null;
  let raw: unknown;
  try { raw = JSON.parse(payload); } catch { return null; }
  if (typeof raw !== 'object' || raw === null) return null;
  const { kind, conversationId } = raw as { kind?: unknown; conversationId?: unknown };
  if (typeof kind !== 'string' || !KINDS.includes(kind) || typeof conversationId !== 'string' || !conversationId) return null;
  return { kind: kind as AgentEventKind, conversationId };
}
