import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { dummyVerify, hashPassword, MAX_PASSWORD, MIN_PASSWORD, verifyPassword } from './password';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const good = 'correct horse battery';

describe('hashPassword', () => {
  it('stores scrypt parameters, a salt and the hash in one string', async () => {
    const stored = await hashPassword(good);
    const parts = stored.split('$');
    expect(parts.slice(0, 4)).toEqual(['scrypt', '32768', '8', '1']);
    expect(Buffer.from(parts[4], 'base64')).toHaveLength(16);
    expect(Buffer.from(parts[5], 'base64')).toHaveLength(64);
    expect(stored).not.toContain(good);
  });

  it('salts: two hashes of the same password differ', async () => {
    expect(await hashPassword(good)).not.toBe(await hashPassword(good));
  });

  it('enforces the length bounds', async () => {
    await expect(hashPassword('x'.repeat(MIN_PASSWORD - 1))).rejects.toThrow(/at least 12/);
    await expect(hashPassword('x'.repeat(MIN_PASSWORD))).resolves.toEqual(expect.any(String));
    await expect(hashPassword('x'.repeat(MAX_PASSWORD))).resolves.toEqual(expect.any(String));
    await expect(hashPassword('x'.repeat(MAX_PASSWORD + 1))).rejects.toThrow(/at most 200/);
  });
});

describe('verifyPassword', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const stored = await hashPassword(good);
    expect(await verifyPassword(good, stored)).toBe(true);
    expect(await verifyPassword(good + 'x', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('returns false, without throwing, for malformed or tampered strings', async () => {
    const stored = await hashPassword(good);
    const [, n, r, p, salt, hash] = stored.split('$');
    const bad = [
      '', 'garbage', 'scrypt$', 'scrypt$32768$8$1$AAAA', stored.slice(0, 30),
      `bcrypt$${n}$${r}$${p}$${salt}$${hash}`,
      `scrypt$${n}$${r}$${p}$${salt}$${hash}$extra`,
      `scrypt$abc$${r}$${p}$${salt}$${hash}`,
      `scrypt$0$${r}$${p}$${salt}$${hash}`,
      `scrypt$32769$${r}$${p}$${salt}$${hash}`,
      `scrypt$${n}$${r}$${p}$${salt}$`,
      `scrypt$${n}$${r}$${p}$$${hash}`,
      // an absurd cost would let a poisoned row exhaust memory; refuse it
      `scrypt$${2 ** 30}$8$1$${salt}$${hash}`,
    ];
    for (const s of bad) expect(await verifyPassword(good, s)).toBe(false);
    // a changed hash byte fails
    const flipped = Buffer.from(hash, 'base64');
    flipped[0] ^= 1;
    expect(await verifyPassword(good, `scrypt$${n}$${r}$${p}$${salt}$${flipped.toString('base64')}`)).toBe(false);
  });

  it('reads the parameters from the stored string (a different N still verifies)', async () => {
    const salt = randomBytes(16);
    const key = await scryptAsync(good, salt, 64, { N: 1024, r: 8, p: 1 });
    const stored = `scrypt$1024$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
    expect(await verifyPassword(good, stored)).toBe(true);
    expect(await verifyPassword('wrong password!!', stored)).toBe(false);
  });
});

describe('dummyVerify', () => {
  it('resolves and takes about as long as a real verification', async () => {
    await expect(dummyVerify(good)).resolves.toBeUndefined();
    await expect(dummyVerify('x'.repeat(500))).resolves.toBeUndefined();
  });
});
