import {
  CUSTOMER_IDLE_HOURS, type CustomerAuthStore, type CustomerIdentity,
} from '../src/auth/customer.store';

interface Link { customerId: number; hash: string; createdAt: number; expiresAt: number; usedAt: number | null }
interface Session { customerId: number; createdAt: number; lastSeenAt: number; expiresAt: number }

/** In-memory CustomerAuthStore for unit tests; `now` is injectable so expiry needs no sleeping. */
export class MemoryCustomerAuthStore implements CustomerAuthStore {
  links: Link[] = [];
  sessions = new Map<string, Session>();
  now = () => Date.now();

  constructor(private readonly customers: CustomerIdentity[]) {}

  async findCustomerByEmail(email: string) {
    return this.customers.find((c) => c.email.toLowerCase() === email.toLowerCase()) ?? null;
  }

  async createLoginLink(customerId: number, hash: string, ttlMinutes: number, limits: { maxPerHour: number; keepUnused: number }) {
    const t = this.now();
    const recent = this.links.filter((l) => l.customerId === customerId && l.createdAt > t - 3_600_000).length;
    if (recent >= limits.maxPerHour) return false;
    this.links.push({ customerId, hash, createdAt: t, expiresAt: t + ttlMinutes * 60_000, usedAt: null });
    const live = this.links.filter((l) => l.customerId === customerId && l.usedAt === null && l.expiresAt > t);
    for (const l of live.slice(0, Math.max(0, live.length - limits.keepUnused))) l.expiresAt = t; // oldest first
    return true;
  }

  async consumeLoginLink(hash: string) {
    const t = this.now();
    const link = this.links.find((l) => l.hash === hash && l.usedAt === null && l.expiresAt > t);
    if (!link) return null;
    link.usedAt = t;
    return this.customers.find((c) => c.id === link.customerId) ?? null;
  }

  async createSession(customerId: number, hash: string, ttlDays: number) {
    const t = this.now();
    this.sessions.set(hash, { customerId, createdAt: t, lastSeenAt: t, expiresAt: t + ttlDays * 86_400_000 });
  }

  async resolveSession(hash: string) {
    const s = this.sessions.get(hash);
    const t = this.now();
    if (!s || s.expiresAt <= t || s.lastSeenAt <= t - CUSTOMER_IDLE_HOURS * 3_600_000) return null;
    if (s.lastSeenAt < t - 60_000) s.lastSeenAt = t;
    return this.customers.find((c) => c.id === s.customerId) ?? null;
  }

  async deleteSession(hash: string) { this.sessions.delete(hash); }

  async deleteSessionsForCustomer(customerId: number) {
    for (const [h, s] of this.sessions) if (s.customerId === customerId) this.sessions.delete(h);
  }

  async deleteExpired() {
    const t = this.now();
    for (const [h, s] of this.sessions) if (s.expiresAt <= t || s.lastSeenAt <= t - CUSTOMER_IDLE_HOURS * 3_600_000) this.sessions.delete(h);
  }
}
