import { seconds, Throttle } from '@nestjs/throttler';
import { loadLoginLimit, loadRateLimits, type RateLimits } from '../config';

/** Per-route override of the global per-client limit; read per request so it follows the environment. */
export const limited = (pick: (limits: RateLimits) => number) =>
  Throttle({ default: { limit: () => pick(loadRateLimits()), ttl: seconds(60) } });

/** The login route's own limit (guessing passwords is the abuse to slow down). */
export const limitedLogin = () => Throttle({ default: { limit: () => loadLoginLimit(), ttl: seconds(60) } });
