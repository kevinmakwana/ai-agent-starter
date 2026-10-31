import { seconds, Throttle } from '@nestjs/throttler';
import { loadCustomerLoginLimit, loadLoginLimit, loadRateLimits, type RateLimits } from '../config';

/** Per-route override of the global per-client limit; read per request so it follows the environment. */
export const limited = (pick: (limits: RateLimits) => number) =>
  Throttle({ default: { limit: () => pick(loadRateLimits()), ttl: seconds(60) } });

/** The login route's own limit (guessing passwords is the abuse to slow down). */
export const limitedLogin = () => Throttle({ default: { limit: () => loadLoginLimit(), ttl: seconds(60) } });

/** Asking for or redeeming a sign-in link: per client, so it says nothing about which emails exist. */
export const limitedCustomerLogin = () => Throttle({ default: { limit: () => loadCustomerLoginLimit(), ttl: seconds(60) } });
