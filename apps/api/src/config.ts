import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Loads the single root .env (nearest one above cwd). Existing environment variables win. */
export function loadRootEnv(startDir = process.cwd()): void {
  for (let dir = startDir; ; dir = dirname(dir)) {
    const file = resolve(dir, '.env');
    if (existsSync(file)) return process.loadEnvFile(file);
    if (dirname(dir) === dir) return;
  }
}

export type ProviderName = 'mock' | 'openai' | 'anthropic';

export interface AppConfig {
  port: number;
  databaseUrl: string;
  maxSteps: number;
  provider: ProviderName;
  mockDelayMs: number;
  openai: { apiKey: string; model: string; baseUrl: string };
  anthropic: { apiKey: string; model: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const provider = (env.LLM_PROVIDER || 'mock') as ProviderName;
  if (!['mock', 'openai', 'anthropic'].includes(provider)) {
    throw new Error(`LLM_PROVIDER must be mock, openai or anthropic (got "${provider}")`);
  }
  const user = env.POSTGRES_USER || 'postgres';
  const pass = env.POSTGRES_PASSWORD || 'postgres';
  const db = env.POSTGRES_DB || 'aiagent';
  const cfg: AppConfig = {
    port: Number(env.API_PORT || 3001),
    databaseUrl: env.DATABASE_URL || `postgres://${user}:${pass}@localhost:${env.DB_PORT || 5432}/${db}`,
    maxSteps: Number(env.AGENT_MAX_STEPS || 8),
    provider,
    mockDelayMs: Number(env.MOCK_DELAY_MS ?? 150),
    openai: {
      apiKey: env.OPENAI_API_KEY || '',
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
      baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    },
    anthropic: { apiKey: env.ANTHROPIC_API_KEY || '', model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5' },
  };
  if (provider === 'openai' && !cfg.openai.apiKey) throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY');
  if (provider === 'anthropic' && !cfg.anthropic.apiKey) throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  return cfg;
}
