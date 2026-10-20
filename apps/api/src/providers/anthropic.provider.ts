import { UpstreamLlmError } from '../agent/errors';
import type { ChatMessage, ChatProvider, Completion, ToolSpec } from '../agent/types';
import { errorDetail, fetchWithRetry, readJson, type RetryOptions } from './retry';

export interface AnthropicOptions extends RetryOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Output cap per call. Thinking tokens count against it, so keep it generous. Default 4096. */
  maxTokens?: number;
  fetch?: typeof fetch;
}

/** Messages API adapter. Plain fetch, no SDK. */
export class AnthropicProvider implements ChatProvider {
  readonly name = 'anthropic';
  readonly model: string;
  constructor(private readonly opts: AnthropicOptions) {
    this.model = opts.model;
  }

  async complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<Completion> {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const res = await fetchWithRetry(
      this.name,
      this.opts.fetch ?? fetch,
      `${this.opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`,
      () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.opts.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: this.opts.model,
          max_tokens: this.opts.maxTokens ?? 4096,
          // Prompt caching is a prefix match over tools -> system -> messages; this caches up to the last block,
          // so the stable tools + system prompt (and earlier turns) are read from cache on the next call.
          cache_control: { type: 'ephemeral' },
          system,
          messages: toAnthropic(messages.filter((m) => m.role !== 'system')),
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        }),
        signal: AbortSignal.timeout(60_000),
      }),
      this.opts,
    );
    if (!res.ok) throw new UpstreamLlmError(this.name, `provider returned HTTP ${res.status}`, await errorDetail(res));

    const data = await readJson(this.name, res);
    if (!Array.isArray(data?.content)) throw new UpstreamLlmError(this.name, 'response contained no content');
    // A cut-off tool_use has incomplete input: never hand it to the agent to execute.
    if (data.stop_reason === 'max_tokens') {
      throw new UpstreamLlmError(this.name, 'the response was cut off at the token limit', 'stop_reason=max_tokens; raise LLM_MAX_TOKENS');
    }
    if (data.stop_reason === 'model_context_window_exceeded') {
      throw new UpstreamLlmError(this.name, 'the response was cut off at the context window', 'stop_reason=model_context_window_exceeded; lower CONTEXT_MAX_TOKENS');
    }
    if (data.stop_reason === 'refusal') {
      throw new UpstreamLlmError(this.name, 'the model declined to respond', `stop_reason=refusal ${JSON.stringify(data.stop_details ?? {})}`);
    }
    const text = data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    return {
      text: text || undefined,
      toolCalls: data.content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, name: b.name, args: b.input })),
      usage: data.usage ? usageOf(data.usage) : undefined,
    };
  }
}

/** With caching, input_tokens excludes cached tokens: the prompt size is the sum of all three. */
function usageOf(u: any): NonNullable<Completion['usage']> {
  const read = u.cache_read_input_tokens ?? 0;
  return {
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + read,
    outputTokens: u.output_tokens ?? 0,
    cachedInputTokens: read || undefined,
  };
}

/** Tool results travel as tool_result blocks in a user turn; consecutive results share one turn. */
function toAnthropic(messages: ChatMessage[]) {
  const out: { role: 'user' | 'assistant'; content: any[] | string }[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const prev = out[out.length - 1];
      if (prev?.role === 'user' && Array.isArray(prev.content) && prev.content[0]?.type === 'tool_result') prev.content.push(block);
      else out.push({ role: 'user', content: [block] });
    } else if (m.role === 'assistant') {
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) {
        const input = c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? c.args : {};
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input });
      }
      out.push({ role: 'assistant', content: blocks });
    } else out.push({ role: 'user', content: m.content });
  }
  return out;
}
