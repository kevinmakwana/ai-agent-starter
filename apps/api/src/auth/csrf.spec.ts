import { csrfOk, hasCsrfHeader } from './csrf';
import type { Principal } from './principal';

const reviewer: Principal = { kind: 'reviewer', id: 'r1', email: 'a@b.c', name: 'A', role: 'reviewer' };
const req = (method: string, header?: string) => ({ method, headers: header === undefined ? {} : { 'x-requested-by': header } });

describe('csrfOk', () => {
  it('lets cookie-authenticated reads through without the header', () => {
    expect(csrfOk(req('GET'), reviewer)).toBe(true);
    expect(csrfOk(req('HEAD'), reviewer)).toBe(true);
  });

  it('requires the exact header value for cookie-authenticated mutations', () => {
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect(csrfOk(req(m), reviewer)).toBe(false);
      expect(csrfOk(req(m, 'something-else'), reviewer)).toBe(false);
      expect(csrfOk(req(m, 'reviewer-console'), reviewer)).toBe(true);
    }
  });

  it('does not apply to key, demo or anonymous callers (no ambient credentials)', () => {
    for (const p of [{ kind: 'key' }, { kind: 'demo' }, { kind: 'none' }] as Principal[]) expect(csrfOk(req('POST'), p)).toBe(true);
  });
});

const customer: Principal = { kind: 'customer', customerId: 1, email: 'ava@example.com', name: 'Ava' };

describe('csrfOk for a customer session', () => {
  it('lets reads through and requires the header for mutations, like a reviewer cookie', () => {
    expect(csrfOk(req('GET'), customer)).toBe(true);
    expect(csrfOk(req('POST'), customer)).toBe(false);
    expect(csrfOk(req('POST', 'something-else'), customer)).toBe(false);
    expect(csrfOk(req('POST', 'reviewer-console'), customer)).toBe(true);
  });

  it('hasCsrfHeader is true only for the exact value', () => {
    expect(hasCsrfHeader(req('POST', 'reviewer-console'))).toBe(true);
    expect(hasCsrfHeader(req('POST'))).toBe(false);
    expect(hasCsrfHeader(req('POST', 'x'))).toBe(false);
  });
});
