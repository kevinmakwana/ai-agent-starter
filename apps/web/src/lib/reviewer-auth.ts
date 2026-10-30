import type { Approval, Reviewer } from './types';

/** In accounts mode the console shows the login form until `/auth/me` has answered with a reviewer. Key and demo mode never do. */
export const needsLogin = (health: { reviewerAccounts: boolean } | null, me: Reviewer | null): boolean =>
  health?.reviewerAccounts === true && me === null;

/** "1 of 2 approvals · Bob" for an action that needs two; null when one approval is enough (or the API did not say). */
export function approvalProgress(a: Approval): string | null {
  if ((a.approvalsRequired ?? 1) < 2) return null;
  const who = a.approvedBy?.length ? ` · ${a.approvedBy.join(', ')}` : '';
  return `${a.approvalsGiven ?? 0} of ${a.approvalsRequired} approvals${who}`;
}

/** Whether Approve should be offered. The API enforces all of this too; this only keeps the button honest. */
export function canApprove(a: Approval, me: Reviewer | null): { allowed: boolean; reason: string | null } {
  if (a.status !== 'pending_approval') return { allowed: false, reason: 'Already decided.' };
  if ((a.approvalsRequired ?? 1) < 2) return { allowed: true, reason: null };
  if (!me) return { allowed: false, reason: 'Two reviewers must approve this. Sign in with a reviewer account to approve.' };
  if (a.approvedByIds?.includes(me.id)) return { allowed: false, reason: 'You already approved this. A different reviewer must give the second approval.' };
  return { allowed: true, reason: null };
}
