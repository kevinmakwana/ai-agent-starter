import { UpstreamLlmError } from '../agent/errors';
import type { ChatMessage, ChatProvider, ToolSpec } from '../agent/types';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiProvider } from './openai.provider';

const tools: ToolSpec[] = [{ name: 'get_order', description: 'd', inputSchema: { type: 'object' } }];
const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'order 1?' }];

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

/** A fetch that replays the given responses (or throws the given errors) in order. */
const script = (...steps: (Response | Error)[]) => {
  const queue = [...steps];
  return jest.fn(async (_url: unknown, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    return next;
  });
};

interface Flavor {
  name: string;
  make: (fetch: ReturnType<typeof script>, extra?: Record<string, unknown>) => ChatProvider;
  ok: (text?: string) => Response;
  toolCall: (stop?: string) => Response;
  text: (text: string, stop: string) => Response;
  overloaded: number;
}

const anthropic: Flavor = {
  name: 'anthropic',
  make: (fetch, extra) => new AnthropicProvider({ apiKey: 'k', model: 'm', fetch, ...extra }),
  ok: (text = 'hi') => res(200, { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
  toolCall: (stop = 'tool_use') => res(200, { content: [{ type: 'tool_use', id: 'u1', name: 'get_order', input: { orderId: 1 } }], stop_reason: stop }),
  text: (text, stop) => res(200, { content: [{ type: 'text', text }], stop_reason: stop }),
  overloaded: 529,
};
const openai: Flavor = {
  name: 'openai',
  make: (fetch, extra) => new OpenAiProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://x.test/v1', fetch, ...extra }),
  ok: (text = 'hi') => res(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  toolCall: (stop = 'tool_calls') => res(200, { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'get_order', arguments: '{"orderId":1}' } }] }, finish_reason: stop }] }),
  text: (text, stop) => res(200, { choices: [{ message: { content: text }, finish_reason: stop }] }),
  overloaded: 503,
};

describe.each([anthropic, openai])('$name adapter: retries', (f) => {
  const delays: number[] = [];
  const sleep = async (ms: number) => { delays.push(ms); };
  beforeEach(() => { delays.length = 0; });

  it('retries rate limits and server errors, then succeeds', async () => {
    const fetch = script(res(429), res(500), f.ok('finally'));
    const out = await f.make(fetch, { maxRetries: 3, sleep, random: () => 0 }).complete(messages, tools);
    expect(out.text).toBe('finally');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(2);
  });

  it('honours Retry-After (seconds) instead of its own backoff', async () => {
    const fetch = script(res(429, {}, { 'retry-after': '2' }), f.ok());
    await f.make(fetch, { maxRetries: 2, sleep, random: () => 0.9 }).complete(messages, tools);
    expect(delays).toEqual([2000]);
  });

  it('backs off exponentially with jitter when the server gives no hint', async () => {
    const fetch = script(res(f.overloaded), res(f.overloaded), f.ok());
    await f.make(fetch, { maxRetries: 2, sleep, random: () => 0.5 }).complete(messages, tools);
    expect(delays).toEqual([250, 500]); // 0.5 * 500ms, then 0.5 * 1000ms
  });

  it('caps the backoff', async () => {
    const fetch = script(res(500), res(500), res(500), f.ok());
    await f.make(fetch, { maxRetries: 3, baseDelayMs: 10_000, maxDelayMs: 12_000, sleep, random: () => 1 }).complete(messages, tools);
    expect(delays).toEqual([10_000, 12_000, 12_000]);
  });

  it('gives up after maxRetries and reports the last status', async () => {
    const fetch = script(res(f.overloaded), res(f.overloaded), res(f.overloaded), f.ok());
    const err = await f.make(fetch, { maxRetries: 2, sleep }).complete(messages, tools).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamLlmError);
    expect(err.message).toContain(`HTTP ${f.overloaded}`);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 403, 404])('never retries HTTP %i', async (status) => {
    const fetch = script(res(status), f.ok());
    await expect(f.make(fetch, { maxRetries: 3, sleep }).complete(messages, tools)).rejects.toBeInstanceOf(UpstreamLlmError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('retries network failures', async () => {
    const fetch = script(new Error('ECONNRESET'), f.ok('back'));
    const out = await f.make(fetch, { maxRetries: 2, sleep }).complete(messages, tools);
    expect(out.text).toBe('back');
  });

  it('does not wait out a Retry-After longer than its cap: the caller gets the error now', async () => {
    const fetch = script(res(429, {}, { 'retry-after': '120' }), f.ok());
    const err = await f.make(fetch, { maxRetries: 2, maxDelayMs: 30_000, sleep }).complete(messages, tools).catch((e) => e);
    expect(err.message).toContain('HTTP 429');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('does not retry unless asked to', async () => {
    const fetch = script(res(500), f.ok());
    await expect(f.make(fetch, { sleep }).complete(messages, tools)).rejects.toBeInstanceOf(UpstreamLlmError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives every attempt a fresh timeout signal', async () => {
    const fetch = script(res(500), res(500), f.ok());
    await f.make(fetch, { maxRetries: 2, sleep }).complete(messages, tools);
    const signals = fetch.mock.calls.map(([, init]) => init!.signal as AbortSignal);
    expect(new Set(signals).size).toBe(3);
    expect(signals.every((s) => !s.aborted)).toBe(true);
  });
});

describe('truncated and declined responses are never executed', () => {
  it.each([
    ['anthropic: tool call cut off by max_tokens', anthropic.toolCall('max_tokens'), anthropic, /cut off/],
    ['anthropic: answer cut off by max_tokens', anthropic.text('Your order is on its wa', 'max_tokens'), anthropic, /cut off/],
    ['anthropic: refusal', anthropic.text('', 'refusal'), anthropic, /declined/],
    ['openai: tool call cut off by length', openai.toolCall('length'), openai, /cut off/],
    ['openai: answer cut off by length', openai.text('Your order is on its wa', 'length'), openai, /cut off/],
    ['openai: content filter', openai.text('', 'content_filter'), openai, /declined/],
  ] as const)('%s', async (_name, response, f, message) => {
    const err = await f.make(script(response)).complete(messages, tools).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamLlmError);
    expect(err.message).toMatch(message);
  });

  it.each([
    [anthropic, anthropic.toolCall('tool_use')],
    [anthropic, anthropic.text('done', 'end_turn')],
    [anthropic, anthropic.text('done', 'stop_sequence')],
    [openai, openai.toolCall('tool_calls')],
    [openai, openai.text('done', 'stop')],
  ] as const)('%# lets a normal stop reason through', async (f, response) => {
    await expect(f.make(script(response)).complete(messages, tools)).resolves.toBeDefined();
  });
});

describe('token limits and caching', () => {
  const bodyOf = (fetch: ReturnType<typeof script>) => JSON.parse(String(fetch.mock.calls[0][1]!.body));

  it('Anthropic: asks for the cacheable prefix to be cached and defaults max_tokens to 4096 (thinking counts against it)', async () => {
    const fetch = script(anthropic.ok());
    await anthropic.make(fetch).complete(messages, tools);
    expect(bodyOf(fetch)).toMatchObject({ cache_control: { type: 'ephemeral' }, max_tokens: 4096 });
  });

  it('Anthropic: max_tokens is configurable', async () => {
    const fetch = script(anthropic.ok());
    await anthropic.make(fetch, { maxTokens: 777 }).complete(messages, tools);
    expect(bodyOf(fetch).max_tokens).toBe(777);
  });

  it('Anthropic: counts cached prompt tokens in the input total and reports cache reads separately', async () => {
    const fetch = script(res(200, {
      content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn',
      usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 5 },
    }));
    const out = await anthropic.make(fetch).complete(messages, tools);
    expect(out.usage).toEqual({ inputTokens: 510, outputTokens: 5, cachedInputTokens: 300 });
  });

  it('Anthropic: omits cachedInputTokens when nothing was read from cache', async () => {
    const out = await anthropic.make(script(anthropic.ok())).complete(messages, tools);
    expect(out.usage?.cachedInputTokens).toBeUndefined();
  });

  it('OpenAI: sends no token limit unless one is configured (compatible servers differ), then max_completion_tokens', async () => {
    const plain = script(openai.ok());
    await openai.make(plain).complete(messages, tools);
    expect(bodyOf(plain)).not.toHaveProperty('max_completion_tokens');
    expect(bodyOf(plain)).not.toHaveProperty('max_tokens');

    const limited = script(openai.ok());
    await openai.make(limited, { maxTokens: 500 }).complete(messages, tools);
    expect(bodyOf(limited).max_completion_tokens).toBe(500);
  });

  it('OpenAI: reports cached prompt tokens', async () => {
    const out = await openai.make(script(res(200, {
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 400, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 128 } },
    }))).complete(messages, tools);
    expect(out.usage).toEqual({ inputTokens: 400, outputTokens: 6, cachedInputTokens: 128 });
  });
});
