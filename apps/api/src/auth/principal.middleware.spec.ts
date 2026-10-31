import type { Request, Response } from 'express';
import type { AuthService } from './auth.service';
import type { CustomerAuthService } from './customer-auth.service';
import type { CustomerIdentity } from './customer.store';
import type { Principal } from './principal';
import { PrincipalMiddleware } from './principal.middleware';

const AVA: CustomerIdentity = { id: 1, name: 'Ava', email: 'ava@example.com' };
const reviewer: Principal = { kind: 'reviewer', id: 'r1', email: 'a@b.c', name: 'A', role: 'admin' };

async function run(reviewerSide: Principal, customer: CustomerIdentity | null | Error, enabled = true) {
  const resolve = jest.fn(async () => { if (customer instanceof Error) throw customer; return customer; });
  const auth = { resolvePrincipal: async () => reviewerSide } as unknown as AuthService;
  const customers = { enabled, resolve } as unknown as CustomerAuthService;
  const req = { headers: {} } as Request;
  const next = jest.fn();
  await new PrincipalMiddleware(auth, customers).use(req, {} as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  return { principal: req.principal, resolve };
}

describe('PrincipalMiddleware with customer login', () => {
  it('a valid customer session wins over an anonymous caller and over the open demo', async () => {
    const expected = { kind: 'customer', customerId: 1, email: AVA.email, name: AVA.name };
    expect((await run({ kind: 'none' }, AVA)).principal).toEqual(expected);
    expect((await run({ kind: 'demo' }, AVA)).principal).toEqual(expected);
  });

  it('a reviewer cookie or the shared key wins over a customer cookie, which is not even consulted', async () => {
    for (const p of [reviewer, { kind: 'key' } as Principal]) {
      const { principal, resolve } = await run(p, AVA);
      expect(principal).toEqual(p);
      expect(resolve).not.toHaveBeenCalled();
    }
  });

  it('stays what it was without a customer session, and fails closed when the lookup breaks', async () => {
    expect((await run({ kind: 'none' }, null)).principal).toEqual({ kind: 'none' });
    expect((await run({ kind: 'demo' }, null)).principal).toEqual({ kind: 'demo' });
    expect((await run({ kind: 'none' }, new Error('db down'))).principal).toEqual({ kind: 'none' });
  });

  it('never looks for a customer when login is off', async () => {
    const { principal, resolve } = await run({ kind: 'none' }, AVA, false);
    expect(principal).toEqual({ kind: 'none' });
    expect(resolve).not.toHaveBeenCalled();
  });
});
