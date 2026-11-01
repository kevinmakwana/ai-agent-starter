import { UpstreamLlmError } from '../agent/errors';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiProvider } from './openai.provider';

// Provider bodies are network data. Whatever shape arrives, the adapters must produce a Completion or an UpstreamLlmError,
// never a raw TypeError from reading a property of null.

const reply = (body: unknown) => async () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const anthropic = (body: unknown) => new AnthropicProvider({ apiKey: 'k', model: 'm', fetch: reply(body) });
const openai = (body: unknown) => new OpenAiProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://x.test/v1', fetch: reply(body) });
const ask = (p: { complete: (m: never[], t: never[]) => Promise<unknown> }) => p.complete([], []);

describe('Anthropic adapter: malformed bodies', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'ok'],
    ['an object without content', {}],
    ['content that is not an array', { content: 'hello' }],
  ])('rejects %s as an upstream failure', async (_name, body) => {
    await expect(ask(anthropic(body))).rejects.toBeInstanceOf(UpstreamLlmError);
  });

  it('ignores content entries that are not objects instead of crashing on them', async () => {
    const out = await ask(anthropic({ content: [null, 'text', 7, [], { type: 'text', text: 'hello' }], stop_reason: 'end_turn' }));
    expect(out).toMatchObject({ text: 'hello', toolCalls: [] });
  });

  it('gives a tool_use block without a usable id or name empty strings, so the tool is rejected as unknown, not executed', async () => {
    const out = (await ask(anthropic({ content: [{ type: 'tool_use', id: 5, name: null, input: { orderId: 1 } }] }))) as {
      toolCalls: { id: string; name: string }[];
    };
    expect(out.toolCalls).toEqual([{ id: '', name: '', args: { orderId: 1 } }]);
  });

  it('counts a token field that is not a number as 0, instead of concatenating or producing NaN', async () => {
    const out = await ask(
      anthropic({
        content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: '5', output_tokens: null, cache_read_input_tokens: NaN },
      }),
    );
    expect(out).toMatchObject({ usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it('ignores a usage that is not an object', async () => {
    const out = await ask(anthropic({ content: [{ type: 'text', text: 'x' }], usage: 'lots' }));
    expect(out).toMatchObject({ usage: undefined });
  });
});

describe('OpenAI adapter: malformed bodies', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['no choices', {}],
    ['choices that is not an array', { choices: 'x' }],
    ['an empty choices list', { choices: [] }],
    ['a null choice', { choices: [null] }],
    ['a choice without a message', { choices: [{ finish_reason: 'stop' }] }],
    ['a message that is a string', { choices: [{ message: 'hi' }] }],
  ])('rejects %s as an upstream failure', async (_name, body) => {
    await expect(ask(openai(body))).rejects.toBeInstanceOf(UpstreamLlmError);
  });

  it('skips tool_calls entries that are not objects and survives ones with missing parts', async () => {
    const out = await ask(
      openai({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [null, 'x', { id: 7, function: null }, { id: 'c1', function: { name: 'get_order', arguments: '{"orderId":1}' } }],
            },
          },
        ],
      }),
    );
    expect(out).toMatchObject({
      toolCalls: [
        { id: '', name: '', args: {} },
        { id: 'c1', name: 'get_order', args: { orderId: 1 } },
      ],
    });
  });

  it('treats tool_calls that is not a list as no calls', async () => {
    const out = await ask(openai({ choices: [{ message: { content: 'hi', tool_calls: 'nope' } }] }));
    expect(out).toMatchObject({ text: 'hi', toolCalls: [] });
  });

  it('does not accept message content that is not a string as text', async () => {
    const out = await ask(openai({ choices: [{ message: { content: [{ type: 'text', text: 'hi' }] } }] }));
    expect(out).toMatchObject({ text: undefined });
  });

  it('counts token fields that are not numbers as 0', async () => {
    const out = await ask(
      openai({
        choices: [{ message: { content: 'x' } }],
        usage: { prompt_tokens: '12', completion_tokens: {}, prompt_tokens_details: 'cached' },
      }),
    );
    expect(out).toMatchObject({ usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: undefined } });
  });
});
