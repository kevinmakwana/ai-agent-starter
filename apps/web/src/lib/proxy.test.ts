import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { forwardToApi } from './proxy';

/** A fake upstream that records what it was asked and answers with the given response. */
function upstream(response: Response) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return response;
  }) as typeof fetch;
  return { seen, fetchImpl };
}
const headersOf = (init: RequestInit) => new Headers(init.headers);
const call = (req: Request, path: string[], fetchImpl: typeof fetch) => forwardToApi(req, path, { fetchImpl, apiUrl: 'http://api.test' });

describe('forwardToApi: request', () => {
  it('forwards the session cookie and the CSRF header the page set, plus the existing credentials', async () => {
    const { seen, fetchImpl } = upstream(Response.json({ ok: true }));
    const req = new Request('http://web.test/api/approvals/1', {
      method: 'POST',
      headers: {
        cookie: 'reviewer_session=tok', 'x-requested-by': 'reviewer-console', authorization: 'Bearer k', 'x-conversation-token': 'ct',
        'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9', 'x-something-else': 'dropped',
      },
      body: '{"decision":"approve"}',
    });
    await call(req, ['approvals', '1'], fetchImpl);
    const h = headersOf(seen[0].init);
    assert.equal(seen[0].url, 'http://api.test/approvals/1');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.body, '{"decision":"approve"}');
    assert.equal(h.get('cookie'), 'reviewer_session=tok');
    assert.equal(h.get('x-requested-by'), 'reviewer-console');
    assert.equal(h.get('authorization'), 'Bearer k');
    assert.equal(h.get('x-conversation-token'), 'ct');
    assert.equal(h.get('x-forwarded-for'), '203.0.113.9');
    assert.equal(h.get('x-something-else'), null);
  });

  it('never invents the CSRF header: a request without it stays without it', async () => {
    const { seen, fetchImpl } = upstream(Response.json({}));
    await call(new Request('http://web.test/api/auth/logout', { method: 'POST', headers: { cookie: 'reviewer_session=tok' }, body: '' }), ['auth', 'logout'], fetchImpl);
    assert.equal(headersOf(seen[0].init).get('x-requested-by'), null);
  });

  it('passes the query string and PATCH bodies through, and sends no body for GET', async () => {
    const { seen, fetchImpl } = upstream(Response.json({}));
    await call(new Request('http://web.test/api/approvals?status=pending'), ['approvals'], fetchImpl);
    assert.equal(seen[0].url, 'http://api.test/approvals?status=pending');
    assert.equal(seen[0].init.body, undefined);
    await call(new Request('http://web.test/api/reviewers/9', { method: 'PATCH', body: '{"active":false}' }), ['reviewers', '9'], fetchImpl);
    assert.equal(seen[1].init.method, 'PATCH');
    assert.equal(seen[1].init.body, '{"active":false}');
  });
});

describe('forwardToApi: response', () => {
  it('returns every Set-Cookie header separately', async () => {
    const res = new Response('{}', { headers: { 'content-type': 'application/json' } });
    res.headers.append('set-cookie', 'reviewer_session=abc; Path=/; HttpOnly; SameSite=Strict');
    res.headers.append('set-cookie', 'other=1; Path=/');
    const { fetchImpl } = upstream(res);
    const out = await call(new Request('http://web.test/api/auth/login', { method: 'POST', body: '{}' }), ['auth', 'login'], fetchImpl);
    assert.deepEqual(out.headers.getSetCookie(), [
      'reviewer_session=abc; Path=/; HttpOnly; SameSite=Strict',
      'other=1; Path=/',
    ]);
  });

  it('keeps status and content type, and marks event streams uncacheable and unbuffered', async () => {
    const { fetchImpl } = upstream(new Response('data: x\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const out = await call(new Request('http://web.test/api/events'), ['events'], fetchImpl);
    assert.equal(out.status, 200);
    assert.equal(out.headers.get('content-type'), 'text/event-stream');
    assert.equal(out.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(out.headers.get('x-accel-buffering'), 'no');
    const { fetchImpl: f2 } = upstream(Response.json({ message: 'no' }, { status: 401 }));
    assert.equal((await call(new Request('http://web.test/api/approvals'), ['approvals'], f2)).status, 401);
  });

  it('answers 502 when the API is unreachable', async () => {
    const out = await call(new Request('http://web.test/api/health'), ['health'], (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch);
    assert.equal(out.status, 502);
  });
});
