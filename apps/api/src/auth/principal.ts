import type { Request } from 'express';

/** Who is calling a reviewer route. Customers are `none` and use their conversation token instead. */
export type Principal =
  | { kind: 'demo' }
  | { kind: 'key' }
  | { kind: 'reviewer'; id: string; email: string; name: string; role: 'admin' | 'reviewer' }
  | { kind: 'none' };

export type ReviewerPrincipal = Extract<Principal, { kind: 'reviewer' }>;

declare module 'express-serve-static-core' {
  interface Request {
    principal: Principal;
  }
}

export const NONE: Principal = { kind: 'none' };

/** True for demo, key and signed-in reviewers: everyone allowed on reviewer routes. */
export const isReviewerPrincipal = (p: Principal): boolean => p.kind !== 'none';

/** Safe where the middleware did not run (unit tests, a controller used on its own): no principal means `none`. */
export const principalOf = (req: Pick<Request, 'principal'>): Principal => req.principal ?? NONE;

/** Only a signed-in person has an identity; demo and key callers do not. */
export const reviewerOf = (p: Principal): ReviewerPrincipal | null => (p.kind === 'reviewer' ? p : null);
