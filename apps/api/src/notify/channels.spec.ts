import { createHmac } from 'node:crypto';
import { headline, plainText, slackText } from './format';
import { postJson } from './http-post';
import { slackChannel } from './slack.channel';
import { webhookChannel } from './webhook.channel';
import type { ApprovalNote } from './types';

const note = (over: Partial<ApprovalNote> = {}): ApprovalNote => ({
  id: 'a1', tool: 'issue_refund', orderId: 11, amount: 18.75, rule: 'always_review',
  createdAt: '2026-10-29T10:00:00.000Z', consoleUrl: 'https://console.example.com/reviewer', ...over,
});

interface Call { url: string; init: RequestInit }

/** A fetch that records its calls and answers with the given status. */
function fakeFetch(status = 200) {
  const calls: Call[] = [];
  const cancel = jest.fn();
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300, body: { cancel } } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls, cancel };
}

const throwing = (err: Error) => (async () => { throw err; }) as unknown as typeof fetch;
const signal = () => new AbortController().signal;

describe('headline', () => {
  it('describes a refund, a cancellation and other tools', () => {
    expect(headline(note())).toBe('refund $18.75 on order #11');
    expect(headline(note({ tool: 'cancel_order', amount: undefined }))).toBe('cancellation of order #11');
    expect(headline(note({ tool: 'create_ticket', orderId: undefined, amount: undefined }))).toBe('create_ticket');
    expect(headline(note({ tool: 'create_ticket', amount: undefined }))).toBe('create_ticket on order #11');
  });
});

describe('plainText', () => {
  it('carries the headline, rule and console link', () => {
    const text = plainText(note());
    expect(text).toContain('refund $18.75 on order #11');
    expect(text).toContain('always_review');
    expect(text).toContain('https://console.example.com/reviewer');
  });
});

describe('slackText', () => {
  it('includes the headline, the rule and the console link', () => {
    const text = slackText(note());
    expect(text).toContain('refund $18.75 on order #11');
    expect(text).toContain('rule: always_review');
    expect(text).toContain('<https://console.example.com/reviewer|Open the reviewer console>');
  });

  it('omits the rule when there is none', () => {
    expect(slackText(note({ rule: undefined }))).not.toContain('rule:');
  });

  it('escapes & < > in values', () => {
    const text = slackText(note({ tool: 'a<b>&c', orderId: undefined, amount: undefined }));
    expect(text).toContain('a&lt;b&gt;&amp;c');
    expect(text).not.toContain('a<b>');
  });

  it('percent-encodes < > | in the console URL so it cannot break the link', () => {
    const text = slackText(note({ consoleUrl: 'https://x.example.com/a|b<c>d' }));
    expect(text).toContain('<https://x.example.com/a%7Cb%3Cc%3Ed|Open the reviewer console>');
  });
});

describe('webhookChannel', () => {
  const url = 'https://hooks.example.com/SECRET';

  it('POSTs the event as JSON, unsigned without a secret', async () => {
    const { fetchFn, calls } = fakeFetch();
    const s = signal();
    await webhookChannel({ url, fetchFn }).send(note(), s);
    expect(calls).toHaveLength(1);
    const { init } = calls[0];
    expect(calls[0].url).toBe(url);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBe(s);
    expect(JSON.parse(init.body as string)).toEqual({ event: 'approval.requested', approval: note() });
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers).not.toHaveProperty('x-signature');
    expect(headers).not.toHaveProperty('x-timestamp');
  });

  it('signs "<timestamp>.<body>" with HMAC-SHA256 when a secret is set', async () => {
    const { fetchFn, calls } = fakeFetch();
    await webhookChannel({ url, secret: 's3cret', fetchFn, nowSec: () => 1_700_000_000 }).send(note(), signal());
    const { init } = calls[0];
    const headers = init.headers as Record<string, string>;
    const expected = createHmac('sha256', 's3cret').update('1700000000.' + (init.body as string)).digest('hex');
    expect(headers['x-timestamp']).toBe('1700000000');
    expect(headers['x-signature']).toBe(`sha256=${expected}`);
  });

  it('is named webhook', () => {
    expect(webhookChannel({ url }).name).toBe('webhook');
  });
});

describe('slackChannel', () => {
  it('POSTs {"text": slackText(note)}', async () => {
    const { fetchFn, calls } = fakeFetch();
    await slackChannel({ url: 'https://hooks.slack.com/services/T/B/X', fetchFn }).send(note(), signal());
    expect(calls[0].url).toBe('https://hooks.slack.com/services/T/B/X');
    expect(calls[0].init.body).toBe(JSON.stringify({ text: slackText(note()) }));
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(calls[0].init.redirect).toBe('manual');
  });

  it('is named slack', () => {
    expect(slackChannel({ url: 'https://hooks.slack.com/x' }).name).toBe('slack');
  });
});

describe('postJson', () => {
  const url = 'https://hooks.example.com/SECRET';
  const init = { headers: { 'content-type': 'application/json' }, body: '{}', signal: signal() };

  it('resolves on 2xx and cancels the unread body', async () => {
    const { fetchFn, cancel } = fakeFetch(204);
    await expect(postJson(fetchFn, url, init)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalled();
  });

  it('tolerates a response without a body', async () => {
    const fetchFn = (async () => ({ status: 200, ok: true })) as unknown as typeof fetch;
    await expect(postJson(fetchFn, url, init)).resolves.toBeUndefined();
  });

  it('cancels the body on failure too', async () => {
    const { fetchFn, cancel } = fakeFetch(500);
    await expect(postJson(fetchFn, url, init)).rejects.toThrow('HTTP 500');
    expect(cancel).toHaveBeenCalled();
  });

  it('rejects a 302 without following it', async () => {
    const { fetchFn } = fakeFetch(302);
    await expect(postJson(fetchFn, url, init)).rejects.toThrow('HTTP 302');
  });

  it('hides the cause of a network error, which may carry the URL', async () => {
    const fetchFn = throwing(new Error('connect ECONNREFUSED https://hooks.example.com/SECRET'));
    const err = await postJson(fetchFn, url, init).catch((e: Error) => e);
    expect((err as Error).message).toBe('request failed');
    expect((err as Error).message).not.toContain('SECRET');
  });

  it.each(['TimeoutError', 'AbortError'])('reports %s as timed out', async (name) => {
    const e = new Error('The operation was aborted'); e.name = name;
    await expect(postJson(throwing(e), url, init)).rejects.toThrow('timed out');
  });
});
