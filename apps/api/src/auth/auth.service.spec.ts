import { Logger, UnauthorizedException } from '@nestjs/common';
import { MemoryReviewerStore } from '../../test/fake-reviewers';
import { loadConfig } from '../config';
import { AuthService, hashSessionToken } from './auth.service';
import * as password from './password';

const PW = 'correct horse battery';
const cfg = (env: NodeJS.ProcessEnv = {}) => loadConfig(env);
const bearer = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });
const cookie = (token: string) => ({ headers: { cookie: `reviewer_session=${token}` } });
const noCreds = { headers: {} };

async function setup(env: NodeJS.ProcessEnv = {}) {
  const store = new MemoryReviewerStore();
  const auth = new AuthService(store, cfg(env));
  const add = async (email = 'a@example.com', role: 'admin' | 'reviewer' = 'reviewer') =>
    store.createReviewer({ email, name: 'Alex', role, passwordHash: await password.hashPassword(PW) });
  return { store, auth, add };
}

afterEach(() => jest.restoreAllMocks());

describe('resolvePrincipal: modes', () => {
  it('no reviewers and no key is open demo mode', async () => {
    const { auth } = await setup();
    expect(await auth.resolvePrincipal(noCreds)).toEqual({ kind: 'demo' });
  });

  it('no reviewers and a key: the Bearer key, else none', async () => {
    const { auth } = await setup({ REVIEWER_API_KEY: 's3cret' });
    expect(await auth.resolvePrincipal(bearer('s3cret'))).toEqual({ kind: 'key' });
    expect(await auth.resolvePrincipal(bearer('nope'))).toEqual({ kind: 'none' });
    expect(await auth.resolvePrincipal(noCreds)).toEqual({ kind: 'none' });
  });

  it('once a reviewer exists only a valid session cookie counts, and the key is ignored', async () => {
    const { auth, add } = await setup({ REVIEWER_API_KEY: 's3cret' });
    await add();
    expect(await auth.resolvePrincipal(bearer('s3cret'))).toEqual({ kind: 'none' });
    expect(await auth.resolvePrincipal(noCreds)).toEqual({ kind: 'none' });
    expect(await auth.resolvePrincipal(cookie('not-a-session'))).toEqual({ kind: 'none' });
    const { token } = await auth.login('a@example.com', PW);
    expect(await auth.resolvePrincipal(cookie(token))).toEqual({
      kind: 'reviewer', id: expect.any(String), email: 'a@example.com', name: 'Alex', role: 'reviewer',
    });
  });

  it('demo mode ends as soon as the first reviewer exists', async () => {
    const { auth, add } = await setup();
    expect(await auth.resolvePrincipal(noCreds)).toEqual({ kind: 'demo' });
    await add();
    expect(await auth.resolvePrincipal(noCreds)).toEqual({ kind: 'none' });
  });

  it('fails closed when the database cannot be reached', async () => {
    const { auth, store } = await setup();
    jest.spyOn(store, 'hasAnyReviewer').mockRejectedValue(new Error('db down'));
    expect(await auth.resolvePrincipal(noCreds)).toEqual({ kind: 'none' });
  });
});

describe('login', () => {
  it('returns a fresh token and stores only its hash', async () => {
    const { auth, store, add } = await setup();
    await add();
    const a = await auth.login(' A@Example.com ', PW);
    const b = await auth.login('a@example.com', PW);
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([...store.sessions.keys()]).not.toContain(a.token);
    expect(store.sessions.has(hashSessionToken(a.token))).toBe(true);
    expect(a.reviewer).toMatchObject({ email: 'a@example.com', name: 'Alex' });
    expect(JSON.stringify(a.reviewer)).not.toMatch(/hash|password|attempt/i);
  });

  it('answers unknown, wrong-password, inactive and locked identically', async () => {
    const { auth, store, add } = await setup();
    const r = await add('a@example.com');
    const inactive = await add('off@example.com');
    await store.updateReviewer(inactive.id, { active: false });
    const messages: string[] = [];
    for (const [email, pw] of [['nobody@example.com', PW], ['a@example.com', 'wrong password!!'], ['off@example.com', PW]]) {
      const err = await auth.login(email, pw).catch((e) => e);
      expect(err).toBeInstanceOf(UnauthorizedException);
      messages.push(err.message);
    }
    for (let i = 0; i < 5; i++) await auth.login('a@example.com', 'wrong password!!').catch(() => undefined);
    const locked = await auth.login('a@example.com', PW).catch((e) => e);
    expect(locked).toBeInstanceOf(UnauthorizedException);
    messages.push(locked.message);
    expect(new Set(messages)).toEqual(new Set(['Invalid email or password']));
    expect(r.id).toBeDefined();
  });

  it('burns a verification for an unknown email and for inactive or locked accounts', async () => {
    const { auth, store, add } = await setup();
    const dummy = jest.spyOn(password, 'dummyVerify');
    await auth.login('nobody@example.com', PW).catch(() => undefined);
    expect(dummy).toHaveBeenCalledTimes(1);
    const r = await add('off@example.com');
    await store.updateReviewer(r.id, { active: false });
    await auth.login('off@example.com', PW).catch(() => undefined);
    expect(dummy).toHaveBeenCalledTimes(2);
  });

  it('locks for 15 minutes after 5 failures, even for the right password, then recovers', async () => {
    const { auth, store, add } = await setup();
    await add();
    let t = 1_000_000_000_000;
    store.now = () => t;
    for (let i = 0; i < 5; i++) await expect(auth.login('a@example.com', 'wrong password!!')).rejects.toThrow('Invalid email or password');
    await expect(auth.login('a@example.com', PW)).rejects.toThrow('Invalid email or password');
    t += 14 * 60_000;
    await expect(auth.login('a@example.com', PW)).rejects.toThrow('Invalid email or password');
    t += 2 * 60_000;
    await expect(auth.login('a@example.com', PW)).resolves.toMatchObject({ token: expect.any(String) });
  });

  it('a success resets the failure counter', async () => {
    const { auth, add } = await setup();
    await add();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) await auth.login('a@example.com', 'wrong password!!').catch(() => undefined);
      await expect(auth.login('a@example.com', PW)).resolves.toBeDefined();
    }
  });

  it('removes expired sessions when someone logs in', async () => {
    const { auth, store, add } = await setup();
    await add();
    let t = 1_000_000_000_000;
    store.now = () => t;
    const old = await auth.login('a@example.com', PW);
    t += 13 * 3_600_000;
    await auth.login('a@example.com', PW);
    expect(store.sessions.has(hashSessionToken(old.token))).toBe(false);
  });
});

describe('logout and change password', () => {
  it('logout ends only that session', async () => {
    const { auth, add } = await setup();
    await add();
    const one = await auth.login('a@example.com', PW);
    const two = await auth.login('a@example.com', PW);
    await auth.logout(one.token);
    expect(await auth.resolvePrincipal(cookie(one.token))).toEqual({ kind: 'none' });
    expect(await auth.resolvePrincipal(cookie(two.token))).toMatchObject({ kind: 'reviewer' });
  });

  it('changePassword checks the current one, then ends the other sessions and keeps this one', async () => {
    const { auth, add } = await setup();
    const r = await add();
    const one = await auth.login('a@example.com', PW);
    const two = await auth.login('a@example.com', PW);
    await expect(auth.changePassword(r.id, 'not the password', 'a brand new password', one.token)).rejects.toThrow('Current password is incorrect');
    await expect(auth.changePassword(r.id, PW, 'short', one.token)).rejects.toThrow(/at least 12/);
    await auth.changePassword(r.id, PW, 'a brand new password', one.token);
    expect(await auth.resolvePrincipal(cookie(one.token))).toMatchObject({ kind: 'reviewer' });
    expect(await auth.resolvePrincipal(cookie(two.token))).toEqual({ kind: 'none' });
    await expect(auth.login('a@example.com', PW)).rejects.toThrow();
    await expect(auth.login('a@example.com', 'a brand new password')).resolves.toBeDefined();
  });
});

describe('startup warning for four-eyes without accounts', () => {
  const warnings = () => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  it('warns when four-eyes is on but no reviewer exists yet (those approvals cannot be given by key or demo callers)', async () => {
    const warn = warnings();
    const { auth } = await setup({ FOUR_EYES_REFUND_OVER: '100' });
    await auth.onApplicationBootstrap();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/four-eyes.*reviewer:add/i);
    const cancels = await setup({ FOUR_EYES_CANCELLATIONS: 'true' });
    await cancels.auth.onApplicationBootstrap();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not fill the mode cache (the next request must ask the store itself)', async () => {
    warnings();
    const { auth, store } = await setup({ FOUR_EYES_REFUND_OVER: '100' });
    const spy = jest.spyOn(store, 'hasAnyReviewer');
    await auth.onApplicationBootstrap();
    expect(spy).not.toHaveBeenCalled();
  });

  it('stays quiet when four-eyes is off, or reviewer accounts already exist', async () => {
    const warn = warnings();
    const off = await setup();
    await off.auth.onApplicationBootstrap();
    const on = await setup({ FOUR_EYES_REFUND_OVER: '100' });
    await on.add();
    await on.auth.onApplicationBootstrap();
    expect(warn).not.toHaveBeenCalled();
  });

  it('never fails startup when the database cannot answer', async () => {
    warnings();
    const { auth, store } = await setup({ FOUR_EYES_REFUND_OVER: '100' });
    jest.spyOn(store, 'listReviewers').mockRejectedValue(new Error('db down'));
    await expect(auth.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
