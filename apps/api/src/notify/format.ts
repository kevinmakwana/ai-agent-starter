import type { ApprovalNote } from './types';

/** Short description of what is waiting, e.g. `refund $18.75 on order #11`. */
export function headline(n: ApprovalNote): string {
  const order = n.orderId !== undefined ? `order #${n.orderId}` : undefined;
  if (n.tool === 'issue_refund' && n.amount !== undefined && order) return `refund $${n.amount.toFixed(2)} on ${order}`;
  if (n.tool === 'cancel_order' && order) return `cancellation of ${order}`;
  return order ? `${n.tool} on ${order}` : n.tool;
}

/** Plain-text body for email. */
export function plainText(n: ApprovalNote): string {
  return [
    `Approval needed: ${headline(n)}`,
    ...(n.rule ? [`Rule: ${n.rule}`] : []),
    `Requested: ${n.createdAt}`,
    '',
    `Open the reviewer console: ${n.consoleUrl}`,
  ].join('\n');
}

/** Slack control characters in text. */
const escapeSlack = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A `<`, `>` or `|` in the link target would end it early, so they are percent-encoded. */
const slackLink = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\|/g, '%7C');

/** One line for a Slack incoming webhook. */
export function slackText(n: ApprovalNote): string {
  const rule = n.rule ? ` (rule: ${escapeSlack(n.rule)})` : '';
  return `Approval needed: ${escapeSlack(headline(n))}${rule} - <${slackLink(n.consoleUrl)}|Open the reviewer console>`;
}
