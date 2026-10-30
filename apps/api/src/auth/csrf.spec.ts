import { csrfOk } from './csrf';
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
