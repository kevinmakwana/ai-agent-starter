import { UpstreamLlmError } from '../agent/errors';
import type { ChatMessage, ChatProvider, Completion, ToolSpec } from '../agent/types';

export interface OpenAiOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetch?: typeof fetch;
}

/** Chat Completions adapter (works with any OpenAI-compatible endpoint). Plain fetch, no SDK. */
export class OpenAiProvider implements ChatProvider {
  readonly name = 'openai';
  constructor(private readonly opts: OpenAiOptions) {}

  async complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<Completion> {
    const doFetch = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({
          model: this.opts.model,
          messages: messages.map(toOpenAi),
          tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
          tool_choice: 'auto',
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new UpstreamLlmError(this.name, `request failed: ${e instanceof Error ? e.message : e}`);
    }
    if (!res.ok) throw new UpstreamLlmError(this.name, `HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);

    const data: any = await res.json();
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new UpstreamLlmError(this.name, 'response contained no message');
    return {
      text: msg.content ?? undefined,
      toolCalls: (msg.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) })),
      usage: data.usage ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens } : undefined,
    };
  }
}

function toOpenAi(m: ChatMessage) {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
    };
  }
  return { role: m.role, content: m.content };
}

/** Invalid JSON is passed through as a string so schema validation rejects it with a clear message. */
function parseArgs(raw: string): unknown {
  try { return JSON.parse(raw || '{}'); } catch { return raw; }
}
