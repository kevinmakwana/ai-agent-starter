import type { Request } from 'express';

/** Who is calling. Anonymous callers are `none`; customers use their session (login mode) or their conversation token. */
export type Principal =
  | { kind: 'demo' }
  | { kind: 'key' }
  | { kind: 'reviewer'; id: string; email: string; name: string; role: 'admin' | 'reviewer' }
  | { kind: 'customer'; customerId: number; email: string; name: string }
  | { kind: 'none' };

export type ReviewerPrincipal = Extract<Principal, { kind: 'reviewer' }>;
export type CustomerPrincipal = Extract<Principal, { kind: 'customer' }>;

declare module 'express-serve-static-core' {
  interface Request {
    principal: Principal;
  }
}

export const NONE: Principal = { kind: 'none' };

/** True for demo, key and signed-in reviewers. A customer is NOT a reviewer: it must never pass a reviewer check. */
export const isReviewerPrincipal = (p: Principal): boolean => p.kind === 'demo' || p.kind === 'key' || p.kind === 'reviewer';

/** Safe where the middleware did not run (unit tests, a controller used on its own): no principal means `none`. */
export const principalOf = (req: Pick<Request, 'principal'>): Principal => req.principal ?? NONE;

/** Only a signed-in person has an identity; demo and key callers do not. */
export const reviewerOf = (p: Principal): ReviewerPrincipal | null => (p.kind === 'reviewer' ? p : null);

/** The signed-in customer, if the caller is one. */
export const customerOf = (p: Principal): CustomerPrincipal | null => (p.kind === 'customer' ? p : null);
