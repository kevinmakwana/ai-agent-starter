import { seconds, Throttle } from '@nestjs/throttler';
import { loadRateLimits, type RateLimits } from '../config';

/** Per-route override of the global per-client limit; read per request so it follows the environment. */
export const limited = (pick: (limits: RateLimits) => number) =>
  Throttle({ default: { limit: () => pick(loadRateLimits()), ttl: seconds(60) } });
