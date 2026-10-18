import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UpstreamLlmError } from '../agent/errors';
import type { ChatMessage, ToolSpec } from '../agent/types';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiProvider } from './openai.provider';
import { runSmoke } from './smoke';

// Real HTTP round trips (no injected fetch) against a local server that speaks each vendor's wire format.
// This checks URLs, headers and bodies over an actual socket; it does NOT replace a live-API smoke test.

interface Seen { url: string; headers: IncomingMessage['headers']; body: any }
let server: Server;
let base: string;
let seen: Seen[] = [];
let reply: (req: Seen) => { status: number; body: unknown } = () => ({ status: 500, body: {} });

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const s: Seen = { url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null };
      seen.push(s);
      const { status, body } = reply(s);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => { seen = []; });

const tools: ToolSpec[] = [{ name: 'get_order', description: 'd', inputSchema: { type: 'object', properties: { orderId: { type: 'integer' } } } }];
const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'where is order 5?' }];

it('OpenAI adapter: POST /chat/completions with bearer auth and tool definitions', async () => {
  reply = () => ({ status: 200, body: {
    choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_order', arguments: '{"orderId":5}' } }] } }],
    usage: { prompt_tokens: 9, completion_tokens: 4 },
  } });
  const out = await new OpenAiProvider({ apiKey: 'sk-test', model: 'm', baseUrl: `${base}/v1` }).complete(messages, tools);
  expect(out.toolCalls).toEqual([{ id: 'c1', name: 'get_order', args: { orderId: 5 } }]);
  expect(seen[0].url).toBe('/v1/chat/completions');
  expect(seen[0].headers.authorization).toBe('Bearer sk-test');
  expect(seen[0].body.tools[0]).toMatchObject({ type: 'function', function: { name: 'get_order' } });
});

it('Anthropic adapter: POST /v1/messages with x-api-key, version header and input_schema', async () => {
  reply = () => ({ status: 200, body: { content: [{ type: 'tool_use', id: 'u1', name: 'get_order', input: { orderId: 5 } }], usage: { input_tokens: 8, output_tokens: 3 } } });
  const out = await new AnthropicProvider({ apiKey: 'ak-test', model: 'm', baseUrl: base }).complete(messages, tools);
  expect(out.toolCalls).toEqual([{ id: 'u1', name: 'get_order', args: { orderId: 5 } }]);
  expect(seen[0].url).toBe('/v1/messages');
  expect(seen[0].headers['x-api-key']).toBe('ak-test');
  expect(seen[0].headers['anthropic-version']).toBe('2023-06-01');
  expect(seen[0].body).toMatchObject({ system: 'sys', messages: [{ role: 'user', content: 'where is order 5?' }] });
  expect(seen[0].body.tools[0].input_schema.type).toBe('object');
});

it('keeps the upstream error body out of the client-facing message', async () => {
  reply = () => ({ status: 401, body: { error: { message: 'Incorrect API key provided: sk-live-SECRET' } } });
  const err = await new OpenAiProvider({ apiKey: 'x', model: 'm', baseUrl: base }).complete(messages, tools).catch((e) => e);
  expect(err).toBeInstanceOf(UpstreamLlmError);
  expect(err.message).toContain('HTTP 401');
  expect(err.message).not.toContain('SECRET');
  expect(err.detail).toContain('SECRET');
});

it('maps connection failures to UpstreamLlmError', async () => {
  const err = await new AnthropicProvider({ apiKey: 'x', model: 'm', baseUrl: 'http://127.0.0.1:1' }).complete(messages, tools).catch((e) => e);
  expect(err).toBeInstanceOf(UpstreamLlmError);
  expect(err.message).toContain('could not reach');
});

describe('live smoke script (runSmoke), exercised against the local servers', () => {
  const quiet = () => undefined;
  const anthropicTool = { content: [{ type: 'tool_use', id: 'u1', name: 'get_order', input: { orderId: 1 } }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 2 } };
  const anthropicDone = { content: [{ type: 'text', text: 'Order #1 has shipped.' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 6 } };
  const openAiTool = { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_order', arguments: '{"orderId":1}' } }] }, finish_reason: 'tool_calls' }] };
  const openAiDone = { choices: [{ message: { content: 'Order #1 has shipped.' }, finish_reason: 'stop' }] };

  it('Anthropic: asks, runs the tool-call round trip with the result fed back, and gets a final answer', async () => {
    reply = (r) => ({ status: 200, body: r.body.messages.length === 1 ? anthropicTool : anthropicDone });
    await runSmoke(new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: base }), quiet);
    expect(seen).toHaveLength(2);
    // the second request must replay the tool_use and answer it with a tool_result carrying the same id
    const second = seen[1].body.messages;
    expect(second.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[1].content.find((b: any) => b.type === 'tool_use').id).toBe('u1');
    expect(second[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'u1' });
  });

  it('OpenAI: same round trip', async () => {
    reply = (r) => ({ status: 200, body: r.body.messages.length === 2 ? openAiTool : openAiDone });
    await runSmoke(new OpenAiProvider({ apiKey: 'k', model: 'm', baseUrl: `${base}/v1` }), quiet);
    const second = seen[1].body.messages;
    expect(second.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(second[3]).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
  });

  it('fails when the model does not call the expected tool', async () => {
    reply = () => ({ status: 200, body: anthropicDone });
    await expect(runSmoke(new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: base }), quiet)).rejects.toThrow(/get_order/);
  });

  it('fails when the tool call arguments do not satisfy the real tool schema', async () => {
    reply = () => ({ status: 200, body: { ...anthropicTool, content: [{ type: 'tool_use', id: 'u1', name: 'get_order', input: { orderId: 'one' } }] } });
    await expect(runSmoke(new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: base }), quiet)).rejects.toThrow(/arguments/i);
  });

  it('fails when the second reply is not a final answer', async () => {
    reply = () => ({ status: 200, body: anthropicTool });
    await expect(runSmoke(new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: base }), quiet)).rejects.toThrow(/final answer/i);
  });

  it('fails when the provider rejects the second request (e.g. a history it will not accept)', async () => {
    reply = (r) => (r.body.messages.length === 1 ? { status: 200, body: anthropicTool } : { status: 400, body: { error: 'bad history' } });
    await expect(runSmoke(new AnthropicProvider({ apiKey: 'k', model: 'm', baseUrl: base }), quiet)).rejects.toThrow(/HTTP 400/);
  });
});
