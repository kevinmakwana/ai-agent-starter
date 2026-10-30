import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { api } from './api';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(body: unknown = {}, status = 200) {
  const seen: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return Response.json(body, { status });
  }) as typeof fetch;
  return seen;
}
const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];

describe('api: CSRF header', () => {
  it('is sent on every non-GET call, whoever the caller is (a signed-in reviewer may also use the customer chat)', async () => {
    const seen = stubFetch();
    await api.decide('a1', 'approve', 'ok', {});
    await api.send('c1', 'hi', { token: 't' });
    await api.login('a@example.com', 'pw');
    await api.logout();
    await api.changePassword('old', 'new');
    await api.createReviewer({ email: 'x@example.com', name: 'X', role: 'reviewer', password: 'pw' });
    await api.updateReviewer('r1', { active: false });
    assert.equal(seen.length, 7);
    for (const s of seen) assert.equal(header(s.init, 'x-requested-by'), 'reviewer-console', s.url);
  });

  it('is not sent on reads', async () => {
    const seen = stubFetch([]);
    await api.approvals({});
    await api.reviewers();
    await api.me();
    for (const s of seen) assert.equal(header(s.init, 'x-requested-by'), undefined, s.url);
  });
});

describe('api: accounts', () => {
  it('uses PATCH for reviewer updates and the right paths', async () => {
    const seen = stubFetch({});
    await api.updateReviewer('r1', { role: 'admin' });
    await api.login('a@example.com', 'pw');
    assert.equal(seen[0].url, '/api/reviewers/r1');
    assert.equal(seen[0].init.method, 'PATCH');
    assert.equal(seen[1].url, '/api/auth/login');
    assert.deepEqual(JSON.parse(String(seen[1].init.body)), { email: 'a@example.com', password: 'pw' });
  });

  it('handles an empty 204 reply (logout, password change)', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    await assert.doesNotReject(api.logout());
    await assert.doesNotReject(api.changePassword('old', 'new'));
  });

  it('surfaces the API message and status on failure', async () => {
    stubFetch({ message: 'Invalid email or password' }, 401);
    await assert.rejects(api.login('a@example.com', 'x'), (e: Error & { status?: number }) => e.message === 'Invalid email or password' && e.status === 401);
  });
});
