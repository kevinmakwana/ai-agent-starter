import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Principal } from '../auth/principal';
import { isReviewer, ReviewerGuard } from './reviewer.guard';

describe('isReviewer', () => {
  it('is open when no key is configured (demo mode)', () => {
    expect(isReviewer('', undefined)).toBe(true);
  });

  it('requires the exact bearer key when configured', () => {
    expect(isReviewer('s3cret', 'Bearer s3cret')).toBe(true);
    expect(isReviewer('s3cret', 'Bearer s3cre')).toBe(false);
    expect(isReviewer('s3cret', 'Bearer s3crets')).toBe(false);
    expect(isReviewer('s3cret', 's3cret')).toBe(false); // missing scheme
    expect(isReviewer('s3cret', undefined)).toBe(false);
  });
});

describe('ReviewerGuard', () => {
  const ctx = (principal: Principal | undefined, method = 'GET', headers: Record<string, string> = {}) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ principal, method, headers }) }) }) as unknown as ExecutionContext;
  const guard = new ReviewerGuard();
  const person: Principal = { kind: 'reviewer', id: 'r1', email: 'a@b.c', name: 'A', role: 'reviewer' };

  it('lets demo, key and signed-in principals through', () => {
    for (const p of [{ kind: 'demo' }, { kind: 'key' }, person] as Principal[]) expect(guard.canActivate(ctx(p))).toBe(true);
  });

  it('answers 401 for none, and when the middleware did not run', () => {
    expect(() => guard.canActivate(ctx({ kind: 'none' }))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx(undefined))).toThrow(UnauthorizedException);
  });

  it('answers 403 to a cookie mutation without the CSRF header, and allows it with the header', () => {
    expect(() => guard.canActivate(ctx(person, 'POST'))).toThrow(ForbiddenException);
    expect(guard.canActivate(ctx(person, 'POST', { 'x-requested-by': 'reviewer-console' }))).toBe(true);
    expect(guard.canActivate(ctx({ kind: 'key' }, 'POST'))).toBe(true);
  });
});
