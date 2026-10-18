import { UpstreamLlmError } from '../agent/errors';
import type { ChatMessage, ChatProvider, Completion, ToolSpec } from '../agent/types';
import { fetchWithRetry, type RetryOptions } from './retry';

export interface OpenAiOptions extends RetryOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  /** Sent as max_completion_tokens (reasoning tokens count). Unset = the model's own limit; some compatible servers reject the field. */
  maxTokens?: number;
  fetch?: typeof fetch;
}

/** Chat Completions adapter (works with any OpenAI-compatible endpoint). Plain fetch, no SDK. */
export class OpenAiProvider implements ChatProvider {
  readonly name = 'openai';
  readonly model: string;
  constructor(private readonly opts: OpenAiOptions) {
    this.model = opts.model;
  }

  async complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<Completion> {
    const res = await fetchWithRetry(
      this.name,
      this.opts.fetch ?? fetch,
      `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`,
      () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({
          model: this.opts.model,
          messages: messages.map(toOpenAi),
          tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
          tool_choice: 'auto',
          ...(this.opts.maxTokens ? { max_completion_tokens: this.opts.maxTokens } : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      }),
      this.opts,
    );
    if (!res.ok) throw new UpstreamLlmError(this.name, `provider returned HTTP ${res.status}`, (await res.text()).slice(0, 500));

    const data: any = await res.json();
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new UpstreamLlmError(this.name, 'response contained no message');
    // A cut-off tool call has incomplete arguments: never hand it to the agent to execute.
    const finish = data.choices[0].finish_reason;
    if (finish === 'length') {
      throw new UpstreamLlmError(this.name, 'the response was cut off at the token limit', 'finish_reason=length; raise LLM_MAX_TOKENS');
    }
    if (finish === 'content_filter') throw new UpstreamLlmError(this.name, 'the model declined to respond', 'finish_reason=content_filter');
    return {
      text: msg.content ?? undefined,
      toolCalls: (msg.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) })),
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
            cachedInputTokens: data.usage.prompt_tokens_details?.cached_tokens || undefined,
          }
        : undefined,
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
