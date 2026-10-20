import { ConflictError } from './errors';
import type { AgentRunner } from './runner';
import type { AgentStore } from './types';

export interface ApprovalExpiryDeps {
  store: AgentStore;
  runner: AgentRunner;
  /** Approvals pending longer than this are rejected. 0 = never expire. */
  ttlMs: number;
  now?: () => number;
  onError?: (actionId: string, error: unknown) => void;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** Whole hours from two hours up when exact ("2 hours"), minutes otherwise ("5 minutes", "90 minutes"). */
function describeSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes >= 120 && minutes % 60 === 0 ? plural(minutes / 60, 'hour') : plural(minutes, 'minute');
}

/**
 * Rejects approvals nobody decided in time, through the same path as a human rejection: the parked run
 * resumes and the agent tells the customer, so a forgotten approval never leaves a conversation hanging.
 */
/** A claim younger than this may still be executing; older ones with no result belong to a process that died. */
export const STRANDED_AFTER_MS = 5 * 60_000;

export class ApprovalExpiry {
  constructor(private readonly deps: ApprovalExpiryDeps) {}

  async sweep(): Promise<{ expired: number; failed: number }> {
    const { store, runner, ttlMs, now = Date.now, onError } = this.deps;
    const result = { expired: 0, failed: 0 };
    if (ttlMs <= 0) return result;

    const note = `Expired: no reviewer decision within ${describeSpan(ttlMs)}.`;
    for (const action of await store.listPendingActionsOlderThan(new Date(now() - ttlMs))) {
      try {
        await runner.decide(action.id, 'reject', note);
        result.expired++;
      } catch (e) {
        // Already decided by a reviewer in the meantime is fine; anything else is reported and the sweep carries on.
        if (e instanceof ConflictError) continue;
        result.failed++;
        onError?.(action.id, e);
      }
    }
    return result;
  }

  /** Completes decisions a crashed process claimed but never finished, so the run is not parked forever. */
  async recoverStranded(): Promise<{ recovered: number; failed: number }> {
    const { store, runner, now = Date.now, onError } = this.deps;
    const result = { recovered: 0, failed: 0 };
    for (const action of await store.listStrandedActions(new Date(now() - STRANDED_AFTER_MS))) {
      try {
        await runner.recover(action.id);
        result.recovered++;
      } catch (e) {
        if (e instanceof ConflictError) continue; // finished in the meantime
        result.failed++;
        onError?.(action.id, e);
      }
    }
    return result;
  }
}
