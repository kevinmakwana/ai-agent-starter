import type { Run } from '../agent/types';

export const CUSTOMER_RUN_ERROR = 'Something went wrong on our side. Please try again.';

/** Stored run errors can carry internal detail (hosts, SQL, upstream bodies): only reviewers get them verbatim. */
export const forCaller = <R extends Run>(run: R, reviewer: boolean): R =>
  reviewer || run.error === null ? run : { ...run, error: CUSTOMER_RUN_ERROR };
