import { loadConfig } from '../config';
import { CUSTOMER_COOKIE, customerCookieOptions, readCookie, sessionCookieOptions } from './cookie';

const req = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } });

describe('readCookie', () => {
  it('finds a cookie among several', () => {
    expect(readCookie(req('a=1; reviewer_session=tok; b=2'), 'reviewer_session')).toBe('tok');
    expect(readCookie(req('reviewer_session=tok'), 'reviewer_session')).toBe('tok');
  });

  it('is undefined when absent, empty or the name only matches as a suffix/prefix', () => {
    expect(readCookie(req(), 'reviewer_session')).toBeUndefined();
    expect(readCookie(req(''), 'reviewer_session')).toBeUndefined();
    expect(readCookie(req('xreviewer_session=a; reviewer_session2=b'), 'reviewer_session')).toBeUndefined();
    expect(readCookie(req('reviewer_session'), 'reviewer_session')).toBeUndefined();
  });

  it('decodes percent-encoding, strips quotes and keeps "=" inside values', () => {
    expect(readCookie(req('reviewer_session=a%20b'), 'reviewer_session')).toBe('a b');
    expect(readCookie(req('reviewer_session="quoted"'), 'reviewer_session')).toBe('quoted');
    expect(readCookie(req('reviewer_session=abc=='), 'reviewer_session')).toBe('abc==');
  });

  it('uses the first cookie of a duplicated name and survives undecodable values', () => {
    expect(readCookie(req('reviewer_session=first; reviewer_session=second'), 'reviewer_session')).toBe('first');
    expect(readCookie(req('reviewer_session=%E0%A4%A'), 'reviewer_session')).toBeUndefined();
  });
});

describe('sessionCookieOptions', () => {
  it('is HttpOnly, SameSite=Strict, site-wide, as long as the absolute session', () => {
    const auth = loadConfig({ SESSION_TTL_HOURS: '2' }).auth;
    expect(sessionCookieOptions(auth)).toEqual({ httpOnly: true, sameSite: 'strict', path: '/', secure: false, maxAge: 2 * 3_600_000 });
    expect(sessionCookieOptions(loadConfig({ COOKIE_SECURE: 'true' }).auth).secure).toBe(true);
  });
});

describe('customerCookieOptions', () => {
  it('is HttpOnly, SameSite=Strict, site-wide, as long as the customer session, Secure on request', () => {
    const cfg = loadConfig({ CUSTOMER_SESSION_TTL_DAYS: '3', COOKIE_SECURE: 'true' });
    expect(customerCookieOptions(cfg)).toEqual({ httpOnly: true, sameSite: 'strict', path: '/', secure: true, maxAge: 3 * 86_400_000 });
    expect(CUSTOMER_COOKIE).toBe('customer_session');
    expect(customerCookieOptions(loadConfig({})).secure).toBe(false);
  });
});
