import type { Run, Step } from '../agent/types';

export const CUSTOMER_RUN_ERROR = 'Something went wrong on our side. Please try again.';

/** Stored run errors can carry internal detail (hosts, SQL, upstream bodies): only reviewers get them verbatim. */
export const forCaller = <R extends Run>(run: R, reviewer: boolean): R =>
  reviewer || run.error === null ? run : { ...run, error: CUSTOMER_RUN_ERROR };

export interface Usage { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number }

/** Tokens billed by the model for these steps (only assistant steps that made a model call carry counts). */
export function sumUsage(steps: Pick<Step, 'inputTokens' | 'outputTokens' | 'cachedInputTokens'>[]): Usage {
  const inputTokens = steps.reduce((n, s) => n + (s.inputTokens ?? 0), 0);
  const outputTokens = steps.reduce((n, s) => n + (s.outputTokens ?? 0), 0);
  const cachedInputTokens = steps.reduce((n, s) => n + (s.cachedInputTokens ?? 0), 0);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedInputTokens };
}
