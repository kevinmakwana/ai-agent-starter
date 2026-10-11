import { UpstreamLlmError } from '../agent/errors';
import type { ChatMessage, ToolSpec } from '../agent/types';
import { AnthropicProvider } from './anthropic.provider';
import { MockProvider } from './mock.provider';
import { OpenAiProvider } from './openai.provider';

const tools: ToolSpec[] = [{ name: 'get_order', description: 'd', inputSchema: { type: 'object' } }];
const history: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'order 1?' },
  { role: 'assistant', content: 'checking', toolCalls: [{ id: 'c1', name: 'get_order', args: { orderId: 1 } }, { id: 'c2', name: 'get_order', args: { orderId: 2 } }] },
  { role: 'tool', toolCallId: 'c1', content: '{"a":1}' },
  { role: 'tool', toolCallId: 'c2', content: '{"b":2}' },
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('OpenAiProvider', () => {
  it('maps messages/tools out and tool calls/usage back', async () => {
    const fetchMock = jest.fn().mockResolvedValue(json({
      choices: [{ message: { content: null, tool_calls: [{ id: 't1', function: { name: 'get_order', arguments: '{"orderId":3}' } }] } }],
      usage: { prompt_tokens: 11, completion_tokens: 5 },
    }));
    const p = new OpenAiProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://x.test/v1/', fetch: fetchMock });
    const out = await p.complete(history, tools);

    expect(out).toEqual({ text: undefined, toolCalls: [{ id: 't1', name: 'get_order', args: { orderId: 3 } }], usage: { inputTokens: 11, outputTokens: 5 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://x.test/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.messages[2].tool_calls).toHaveLength(2);
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"a":1}' });
    expect(body.tools[0].function.name).toBe('get_order');
  });

  it('turns HTTP and network failures into UpstreamLlmError', async () => {
    const http = new OpenAiProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://x.test', fetch: async () => json({ error: 'rate limited' }, 429) });
    await expect(http.complete(history, tools)).rejects.toThrow(/openai.*HTTP 429/);
    const net = new OpenAiProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://x.test', fetch: async () => { throw new Error('ECONNREFUSED'); } });
    await expect(net.complete(history, tools)).rejects.toBeInstanceOf(UpstreamLlmError);
  });
});

describe('AnthropicProvider', () => {
  it('groups tool results into one user turn and parses tool_use blocks', async () => {
    const fetchMock = jest.fn().mockResolvedValue(json({
      content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 'u1', name: 'get_order', input: { orderId: 9 } }],
      usage: { input_tokens: 7, output_tokens: 3 },
    }));
    const p = new AnthropicProvider({ apiKey: 'k', model: 'm', fetch: fetchMock });
    const out = await p.complete(history, tools);

    expect(out).toEqual({ text: 'on it', toolCalls: [{ id: 'u1', name: 'get_order', args: { orderId: 9 } }], usage: { inputTokens: 7, outputTokens: 3 } });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['x-api-key']).toBe('k');
    const body = JSON.parse(init.body);
    expect(body.system).toBe('sys');
    expect(body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.messages[2].content.map((b: any) => b.tool_use_id)).toEqual(['c1', 'c2']);
    expect(body.tools[0]).toMatchObject({ name: 'get_order', input_schema: { type: 'object' } });
  });

  it('turns HTTP failures into UpstreamLlmError', async () => {
    const p = new AnthropicProvider({ apiKey: 'k', model: 'm', fetch: async () => json({ error: 'overloaded' }, 529) });
    await expect(p.complete(history, tools)).rejects.toBeInstanceOf(UpstreamLlmError);
  });
});

describe('MockProvider', () => {
  it('is deterministic for the same history', async () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'customerId: 4' }, { role: 'user', content: 'show my recent orders' }];
    const a = await new MockProvider().complete(msgs);
    const b = await new MockProvider().complete(msgs);
    expect(a).toEqual(b);
    expect(a.toolCalls[0]).toMatchObject({ name: 'list_orders', args: { customerId: 4 } });
  });
});
