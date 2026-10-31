import { customerOf, isReviewerPrincipal, principalOf, reviewerOf, type Principal } from './principal';

const all: Record<string, Principal> = {
  demo: { kind: 'demo' }, key: { kind: 'key' },
  reviewer: { kind: 'reviewer', id: 'r1', email: 'a@b.c', name: 'A', role: 'reviewer' },
  customer: { kind: 'customer', customerId: 1, email: 'ava@example.com', name: 'Ava' },
  none: { kind: 'none' },
};

describe('principals', () => {
  it('only demo, key and reviewer are reviewers: a customer and an anonymous caller are not', () => {
    expect(Object.entries(all).filter(([, p]) => isReviewerPrincipal(p)).map(([k]) => k)).toEqual(['demo', 'key', 'reviewer']);
  });

  it('customerOf and reviewerOf only match their own kind', () => {
    expect(customerOf(all.customer)).toEqual(all.customer);
    for (const k of ['demo', 'key', 'reviewer', 'none']) expect(customerOf(all[k])).toBeNull();
    expect(reviewerOf(all.customer)).toBeNull();
  });

  it('no principal means none', () => {
    expect(principalOf({} as never)).toEqual({ kind: 'none' });
  });
});
