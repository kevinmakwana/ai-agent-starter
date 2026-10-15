/**
 * Live smoke test for the real adapters (needs a key; costs a fraction of a cent):
 *   LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run smoke:llm
 * Asks the model a question that should trigger the get_order tool and prints what came back.
 */
import { loadConfig, loadRootEnv } from '../config';
import { toolSpecs } from '../agent/tools';
import { createProvider } from './index';

async function main() {
  loadRootEnv();
  const cfg = loadConfig();
  if (cfg.provider === 'mock') throw new Error('Set LLM_PROVIDER=openai or anthropic (and its API key) first.');
  const provider = createProvider(cfg);
  const out = await provider.complete(
    [
      { role: 'system', content: 'You are a support agent for Acme Shop. Use tools to answer.' },
      { role: 'user', content: 'Where is my order #1?' },
    ],
    toolSpecs(),
  );
  console.log(JSON.stringify(out, null, 2));
  const call = out.toolCalls[0];
  if (call?.name !== 'get_order') throw new Error(`Expected a get_order tool call, got: ${JSON.stringify(out)}`);
  console.log(`OK: ${provider.name} returned a valid tool call.`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
