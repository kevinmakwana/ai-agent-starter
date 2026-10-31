/** A login link works once and for this long. */
export const LINK_TTL_MINUTES = 15;
/** Links created for one customer in a rolling hour; further requests are silently ignored. */
export const LINKS_PER_HOUR = 5;
/** Unused links that stay usable at once; an older one stops working when a newer one is requested. */
export const KEEP_UNUSED_LINKS = 2;
/** A customer session unused for this long ends, whatever its absolute lifetime. */
export const CUSTOMER_IDLE_HOURS = 24;

/** What the rest of the API may know about a signed-in customer. Never a token or a hash. */
export interface CustomerIdentity {
  id: number;
  name: string;
  email: string;
}

export interface CustomerAuthStore {
  /** Case-insensitive. */
  findCustomerByEmail(email: string): Promise<CustomerIdentity | null>;
  /** False when the customer is over the hourly limit; nothing is created then. */
  createLoginLink(
    customerId: number,
    tokenHash: string,
    ttlMinutes: number,
    limits: { maxPerHour: number; keepUnused: number },
  ): Promise<boolean>;
  /** Atomic and single use: of two simultaneous calls with the same hash, at most one returns the customer. */
  consumeLoginLink(tokenHash: string): Promise<CustomerIdentity | null>;
  createSession(customerId: number, tokenHash: string, ttlDays: number): Promise<void>;
  /** Null when unknown, expired or idle; a use refreshes the idle clock (at most once a minute). */
  resolveSession(tokenHash: string): Promise<CustomerIdentity | null>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteSessionsForCustomer(customerId: number): Promise<void>;
  deleteExpired(): Promise<void>;
}
