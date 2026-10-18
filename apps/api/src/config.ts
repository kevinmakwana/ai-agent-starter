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

export interface RateLimits {
  /** Requests per client per minute across the API (except /health). */
  perMinute: number;
  /** POST /conversations per client per minute. */
  startPerMinute: number;
  /** POST /conversations/:id/messages per client per minute (each one can cost LLM calls). */
  messagesPerMinute: number;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer (got "${raw}")`);
  return n;
}

function nonNegativeInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, 0 or more (got "${raw}")`);
  return n;
}

/** Read on their own because route decorators resolve them per request. */
export const loadRateLimits = (env: NodeJS.ProcessEnv = process.env): RateLimits => ({
  perMinute: positiveInt(env, 'RATE_LIMIT_PER_MINUTE', 600),
  startPerMinute: positiveInt(env, 'RATE_LIMIT_START_PER_MINUTE', 10),
  messagesPerMinute: positiveInt(env, 'RATE_LIMIT_MESSAGES_PER_MINUTE', 20),
});

/** Exact origins only (no wildcards): browsers may call the API cross-origin from these and nowhere else. */
function parseCorsOrigins(raw = ''): string[] {
  return raw.split(',').map((o) => o.trim()).filter(Boolean).map((o) => {
    let origin: string | null = null;
    try { origin = new URL(o).origin; } catch { /* handled below */ }
    if (origin !== o) throw new Error(`CORS_ORIGINS entries must be exact origins like https://app.example.com (got "${o}")`);
    return o;
  });
}

/** Number of reverse-proxy hops to trust for X-Forwarded-For (0/unset = trust none). */
function parseTrustProxy(raw = ''): number | false {
  if (raw === '' || raw === '0') return false;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`TRUST_PROXY must be a number of proxy hops, e.g. 1 (got "${raw}")`);
  return n;
}

export type ProviderName = 'mock' | 'openai' | 'anthropic';

export interface AppConfig {
  port: number;
  databaseUrl: string;
  maxSteps: number;
  /** When set, /approvals and /customers require `Authorization: Bearer <key>`. */
  reviewerApiKey: string;
  /** Browser origins allowed to call the API cross-origin. Empty = none (the Next.js proxy is same-origin). */
  corsOrigins: string[];
  /** Proxy hops whose X-Forwarded-For is trusted for client identity; false = use the socket address. */
  trustProxy: number | false;
  rateLimit: RateLimits;
  /** Max tokens (input + output) per conversation before the agent stops calling the model. */
  conversationTokenBudget: number;
  /** Rough cap (tokens) on the conversation history sent to the model per call; older turns are left out. */
  contextMaxTokens: number;
  /** Pending approvals older than this many minutes are auto-rejected. 0 = never expire. */
  approvalTtlMinutes: number;
  /** Extra attempts for retryable provider failures (network, 408, 429, 5xx). */
  llmMaxRetries: number;
  /** Output cap per model call. Unset = Anthropic 4096 / OpenAI the model's own limit. */
  llmMaxTokens?: number;
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
    reviewerApiKey: env.REVIEWER_API_KEY || '',
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    rateLimit: loadRateLimits(env),
    conversationTokenBudget: positiveInt(env, 'CONVERSATION_TOKEN_BUDGET', 200_000),
    contextMaxTokens: positiveInt(env, 'CONTEXT_MAX_TOKENS', 8000),
    approvalTtlMinutes: nonNegativeInt(env, 'APPROVAL_TTL_MINUTES', 1440),
    llmMaxRetries: nonNegativeInt(env, 'LLM_MAX_RETRIES', 2),
    llmMaxTokens: env.LLM_MAX_TOKENS ? positiveInt(env, 'LLM_MAX_TOKENS', 0) : undefined,
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
