import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 200;

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
/** A stored string is data from the database: never let it ask scrypt for more than this. */
const MAX_N = 2 ** 17;
const MAX_R = 16;
const MAX_P = 4;

const maxmem = (n: number, r: number) => 128 * n * r * 2;

function derive(plain: string, salt: Buffer, n: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(plain, salt, keyLen, { N: n, r, p, maxmem: maxmem(n, r) }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** `scrypt$N$r$p$<salt b64>$<hash b64>`; the parameters travel with the hash so they can change later. */
export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  if (plain.length > MAX_PASSWORD) throw new Error(`Password must be at most ${MAX_PASSWORD} characters`);
  const salt = randomBytes(SALT_LEN);
  const key = await derive(plain, salt, N, R, P, KEY_LEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const intParam = (s: string): number => (/^[1-9]\d{0,9}$/.test(s) ? Number(s) : NaN);

/** False for a wrong password and for any malformed `stored`; never throws on bad input. */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    if (plain.length > MAX_PASSWORD) return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const n = intParam(parts[1]);
    const r = intParam(parts[2]);
    const p = intParam(parts[3]);
    // scrypt needs N to be a power of two greater than 1
    if (!(n >= 2 && n <= MAX_N && (n & (n - 1)) === 0 && r <= MAX_R && p <= MAX_P)) return false;
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await derive(plain, salt, n, r, p, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const DUMMY_SALT = Buffer.alloc(SALT_LEN, 7);

/** Burns the time of a real verification, so an unknown email takes as long as a wrong password. */
export async function dummyVerify(plain: string): Promise<void> {
  await derive(plain.slice(0, MAX_PASSWORD), DUMMY_SALT, N, R, P, KEY_LEN);
}
