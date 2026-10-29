import type { Run, Step } from '../agent/types';

export const CUSTOMER_RUN_ERROR = 'Something went wrong on our side. Please try again.';

/** Stored run errors can carry internal detail (hosts, SQL, upstream bodies): only reviewers get them verbatim. */
export const forCaller = <R extends Run>(run: R, reviewer: boolean): R =>
  reviewer || run.error === null ? run : { ...run, error: CUSTOMER_RUN_ERROR };

/** Why a human was needed (rule, threshold) and whether reviewers were notified are reviewer-only: customers never see them. */
export const approvalForCaller = <A extends { policyRule?: unknown; policyDetail?: unknown; notifiedAt?: unknown }>(a: A, reviewer: boolean): A => {
  if (reviewer) return a;
  const { policyRule: _rule, policyDetail: _detail, notifiedAt: _notified, ...rest } = a;
  return rest as A;
};

export interface Usage { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number }

/** Tokens billed by the model for these steps (only assistant steps that made a model call carry counts). */
export function sumUsage(steps: Pick<Step, 'inputTokens' | 'outputTokens' | 'cachedInputTokens'>[]): Usage {
  const inputTokens = steps.reduce((n, s) => n + (s.inputTokens ?? 0), 0);
  const outputTokens = steps.reduce((n, s) => n + (s.outputTokens ?? 0), 0);
  const cachedInputTokens = steps.reduce((n, s) => n + (s.cachedInputTokens ?? 0), 0);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedInputTokens };
}
