import { UpstreamLlmError } from '../agent/errors';
import type { ChatMessage, ChatProvider, Completion, ToolSpec } from '../agent/types';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Messages API adapter. Plain fetch, no SDK. */
export class AnthropicProvider implements ChatProvider {
  readonly name = 'anthropic';
  constructor(private readonly opts: AnthropicOptions) {}

  async complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<Completion> {
    const doFetch = this.opts.fetch ?? fetch;
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    let res: Response;
    try {
      res = await doFetch(`${this.opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.opts.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: this.opts.model,
          max_tokens: 1024,
          system,
          messages: toAnthropic(messages.filter((m) => m.role !== 'system')),
          tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new UpstreamLlmError(this.name, `request failed: ${e instanceof Error ? e.message : e}`);
    }
    if (!res.ok) throw new UpstreamLlmError(this.name, `HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);

    const data: any = await res.json();
    if (!Array.isArray(data?.content)) throw new UpstreamLlmError(this.name, 'response contained no content');
    const text = data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    return {
      text: text || undefined,
      toolCalls: data.content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, name: b.name, args: b.input })),
      usage: data.usage ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens } : undefined,
    };
  }
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
