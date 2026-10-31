import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes, base64url: a session cookie value or a login-link token. */
export const newToken = (): string => randomBytes(32).toString('base64url');

/** Only this hash is stored, so a copy of the database cannot be replayed as a cookie or a link. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
