import type { ApprovalNote, ClaimedAction } from './types';

const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
const RULE = /^[a-z_]{1,40}$/;

const positiveInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;

/** Finite and positive, rounded to cents. A value that rounds to zero is dropped. */
function money(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  const cents = Math.round(v * 100) / 100;
  return cents > 0 ? cents : undefined;
}

/**
 * The one place a notification is assembled. Each field is picked and validated on its own, so nothing else from
 * the row (customer data, free-text reasons, the rest of tool_args) can reach a channel, and a malformed value is
 * omitted rather than forwarded.
 */
export function buildNote(row: ClaimedAction, consoleUrl: string): ApprovalNote {
  const tool = TOOL.test(row.toolName) ? row.toolName : 'unknown';
  const orderId = positiveInt(row.toolArgs.orderId);
  const amount = tool === 'issue_refund' ? money(row.toolArgs.amount) : undefined;
  const rule = row.rule !== null && RULE.test(row.rule) ? row.rule : undefined;
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
