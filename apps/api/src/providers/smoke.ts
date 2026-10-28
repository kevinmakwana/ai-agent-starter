/**
 * Live smoke test for the real adapters (needs a key; costs a fraction of a cent):
 *   LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run smoke:llm
 *
 * Runs the same two-call loop the agent does: ask something that needs get_order, check the tool call against the
 * real tool schema, feed a tool result back, and expect a plain-text answer. The second call is the one that
 * matters most: it replays the model's own tool call, which is where history-format problems show up.
 */
import { UpstreamLlmError } from '../agent/errors';
import { toolSpecs, validateToolInput } from '../agent/tools';
import type { ChatMessage, ChatProvider } from '../agent/types';
import { loadConfig, loadRootEnv } from '../config';
import { createProvider } from './index';

const ORDER = { order: { id: 1, status: 'shipped', total: 18.75, items: [{ name: 'Acme Ceramic Mug', qty: 1 }] }, refundedTotal: 0, refundableRemaining: 18.75 };

export async function runSmoke(provider: ChatProvider, log: (line: string) => void = console.log): Promise<void> {
  const history: ChatMessage[] = [
    { role: 'system', content: 'You are a support agent for Acme Shop. Use tools to answer.' },
    { role: 'user', content: 'What did I order in order #1, and has any of it been refunded?' },
  ];

  const first = await provider.complete(history, toolSpecs());
  log(`1) ${provider.name}: ${JSON.stringify(first)}`);
  const call = first.toolCalls[0];
  if (call?.name !== 'get_order') throw new Error(`Expected a get_order tool call, got: ${JSON.stringify(first)}`);
  const check = validateToolInput(call.name, call.args);
  if (!check.ok) throw new Error(`The tool call arguments do not satisfy the tool schema: ${check.errors.join('; ')}`);

  history.push(
    { role: 'assistant', content: first.text ?? '', toolCalls: first.toolCalls },
    { role: 'tool', toolCallId: call.id, content: JSON.stringify(ORDER) },
  );
  const second = await provider.complete(history, toolSpecs());
  log(`2) ${provider.name}: ${JSON.stringify(second)}`);
  if (second.toolCalls.length > 0 || !second.text?.trim()) {
    throw new Error(`Expected a final answer after the tool result, got: ${JSON.stringify(second)}`);
  }
  log(`OK: ${provider.name}${provider.model ? ` (${provider.model})` : ''} made a valid tool call and answered after the tool result.`);
}

async function main() {
  loadRootEnv();
  const cfg = loadConfig();
  if (cfg.provider === 'mock') throw new Error('Set LLM_PROVIDER=openai or anthropic (and its API key) first.');
  await runSmoke(createProvider(cfg));
}

if (require.main === module) {
  main().catch((e) => {
    // detail (raw upstream body) is for the person running the check; it is never shown to API clients
    console.error(e instanceof Error ? e.message : e);
    if (e instanceof UpstreamLlmError && e.detail) console.error(`detail: ${e.detail}`);
    process.exit(1);
  });
}
