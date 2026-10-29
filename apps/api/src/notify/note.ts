import type { ApprovalNote, ClaimedAction } from './types';

const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
const RULE = /^[a-z_]{1,40}$/;

const positiveInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Positive and rounded to cents. Dropped when it rounds to zero or is too large to hold exactly as cents. */
function money(v: unknown): number | undefined {
  if (typeof v !== 'number') return undefined;
  const cents = Math.round(v * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents / 100 : undefined;
}

/**
 * The one place a notification is assembled. Each field is picked and validated on its own, so nothing else from
 * the row (customer data, free-text reasons, the rest of tool_args) can reach a channel, and a malformed value is
 * omitted rather than forwarded.
 */
export function buildNote(row: ClaimedAction, consoleUrl: string): ApprovalNote {
  const tool = TOOL.test(row.toolName) ? row.toolName : 'unknown';
  // toolArgs comes from a JSON column, so do not trust its shape.
  const args = isRecord(row.toolArgs) ? row.toolArgs : {};
  const orderId = positiveInt(args.orderId);
  const amount = tool === 'issue_refund' ? money(args.amount) : undefined;
  const rule = typeof row.rule === 'string' && RULE.test(row.rule) ? row.rule : undefined;
  return {
    id: row.id,
    tool,
    ...(orderId !== undefined ? { orderId } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(rule !== undefined ? { rule } : {}),
    createdAt: row.createdAt,
    consoleUrl,
  };
}
