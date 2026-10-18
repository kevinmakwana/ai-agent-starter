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

/**
 * Rejects approvals nobody decided in time, through the same path as a human rejection: the parked run
 * resumes and the agent tells the customer, so a forgotten approval never leaves a conversation hanging.
 */
export class ApprovalExpiry {
  constructor(private readonly deps: ApprovalExpiryDeps) {}

  async sweep(): Promise<{ expired: number; failed: number }> {
    const { store, runner, ttlMs, now = Date.now, onError } = this.deps;
    const result = { expired: 0, failed: 0 };
    if (ttlMs <= 0) return result;

    const hours = Math.round((ttlMs / 3_600_000) * 10) / 10;
    const note = `Expired: no reviewer decision within ${hours} hour${hours === 1 ? '' : 's'}.`;
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
}
