export type ReviewerRole = 'admin' | 'reviewer';

/** What the API may show about a reviewer. Never carries the hash or the lockout counters. */
export interface Reviewer {
  id: string;
  email: string;
  name: string;
  role: ReviewerRole;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

/** Server-side only: adds what login needs. Must not be returned from a route. */
export interface ReviewerCredentials extends Reviewer {
  passwordHash: string;
  /** Judged by the database clock, the same one that sets the lock. */
  locked: boolean;
}

export interface NewReviewer {
  email: string;
  name: string;
  role: ReviewerRole;
  passwordHash: string;
}

export interface ReviewerPatch {
  name?: string;
  role?: ReviewerRole;
  active?: boolean;
  passwordHash?: string;
}

/** The signed-in reviewer a session token resolves to. */
export interface SessionReviewer {
  id: string;
  email: string;
  name: string;
  role: ReviewerRole;
}

export const LOCKOUT_AFTER_FAILURES = 5;
export const LOCKOUT_MINUTES = 15;
export const IDLE_TIMEOUT_MINUTES = 30;

export interface ReviewerStore {
  createReviewer(r: NewReviewer): Promise<Reviewer>;
  /** Emails are matched case-insensitively. */
  findByEmail(email: string): Promise<ReviewerCredentials | null>;
  findById(id: string): Promise<Reviewer | null>;
  listReviewers(): Promise<Reviewer[]>;
  /**
   * Changes the given fields. Deactivating, demoting or setting a password also deletes the reviewer's sessions
   * (except `keepSession`, the caller's own); null when the reviewer does not exist.
   */
  updateReviewer(id: string, patch: ReviewerPatch, opts?: { keepSession?: string }): Promise<Reviewer | null>;
  countActiveAdmins(): Promise<number>;
  /** True once any reviewer row exists (switches the API to accounts mode); cached briefly. */
  hasAnyReviewer(): Promise<boolean>;
  /** Counts a failed login atomically and locks the account at the threshold. */
  recordLoginFailure(id: string): Promise<void>;
  /** Clears the failure counter and the lock, and stamps `last_login_at`. */
  recordLoginSuccess(id: string): Promise<void>;
  /** `tokenHash` is the SHA-256 of the cookie value; the token itself is never stored. */
  createSession(reviewerId: string, tokenHash: string, ttlHours: number): Promise<void>;
  /** The reviewer for a live session: active, not past its absolute expiry, not idle. Refreshes `last_seen_at` at most once a minute. */
  resolveSession(tokenHash: string): Promise<SessionReviewer | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteSessionsForReviewer(reviewerId: string, keepSession?: string): Promise<void>;
  deleteExpired(): Promise<void>;
}
