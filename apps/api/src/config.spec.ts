import { loadConfig, loadRateLimits } from './config';

describe('loadConfig', () => {
  it('runs with zero configuration (offline mock provider)', () => {
    const cfg = loadConfig({});
    expect(cfg).toMatchObject({ provider: "mock", port: 3001, maxSteps: 8, reviewerApiKey: "" });
    expect(cfg.databaseUrl).toBe('postgres://postgres:postgres@localhost:5432/aiagent');
  });

  it('honours DB_PORT and DATABASE_URL', () => {
    expect(loadConfig({ DB_PORT: '5433' }).databaseUrl).toContain(':5433/');
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@h:1/d' }).databaseUrl).toBe('postgres://u:p@h:1/d');
  });

  it('requires keys for real providers and rejects unknown ones', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'openai' })).toThrow('OPENAI_API_KEY');
    expect(() => loadConfig({ LLM_PROVIDER: 'anthropic' })).toThrow('ANTHROPIC_API_KEY');
    expect(() => loadConfig({ LLM_PROVIDER: 'gemini' })).toThrow('LLM_PROVIDER');
    expect(loadConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }).provider).toBe('anthropic');
  });
});

describe('token budget config', () => {
  it('defaults to a finite per-conversation budget and validates overrides', () => {
    expect(loadConfig({}).conversationTokenBudget).toBe(200_000);
    expect(loadConfig({ CONVERSATION_TOKEN_BUDGET: '5000' }).conversationTokenBudget).toBe(5000);
    expect(() => loadConfig({ CONVERSATION_TOKEN_BUDGET: '0' })).toThrow('CONVERSATION_TOKEN_BUDGET');
  });
});

describe('context window config', () => {
  it('defaults to an 8000-token window and validates overrides', () => {
    expect(loadConfig({}).contextMaxTokens).toBe(8000);
    expect(loadConfig({ CONTEXT_MAX_TOKENS: '32000' }).contextMaxTokens).toBe(32000);
    expect(() => loadConfig({ CONTEXT_MAX_TOKENS: 'big' })).toThrow('CONTEXT_MAX_TOKENS');
  });
});

describe('approval expiry config', () => {
  it('defaults to 24 hours, allows 0 to disable, and rejects junk', () => {
    expect(loadConfig({}).approvalTtlMinutes).toBe(1440);
    expect(loadConfig({ APPROVAL_TTL_MINUTES: '90' }).approvalTtlMinutes).toBe(90);
    expect(loadConfig({ APPROVAL_TTL_MINUTES: '0' }).approvalTtlMinutes).toBe(0);
    expect(() => loadConfig({ APPROVAL_TTL_MINUTES: '-1' })).toThrow('APPROVAL_TTL_MINUTES');
    expect(() => loadConfig({ APPROVAL_TTL_MINUTES: 'soon' })).toThrow('APPROVAL_TTL_MINUTES');
  });
});

describe('HTTP hardening config', () => {
  it('is locked down by default: no CORS origins, no trusted proxy, generous-but-finite rate limits', () => {
    expect(loadConfig({})).toMatchObject({
      corsOrigins: [],
      trustProxy: false,
      rateLimit: { perMinute: 600, startPerMinute: 10, messagesPerMinute: 20 },
    });
  });

  it('parses CORS_ORIGINS as a trimmed comma list and TRUST_PROXY as a hop count', () => {
    const cfg = loadConfig({ CORS_ORIGINS: ' https://a.example.com, https://b.example.com ,', TRUST_PROXY: '1' });
    expect(cfg.corsOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(cfg.trustProxy).toBe(1);
  });

  it('rejects values that would silently disable protection', () => {
    expect(() => loadConfig({ RATE_LIMIT_PER_MINUTE: '0' })).toThrow('RATE_LIMIT_PER_MINUTE');
    expect(() => loadConfig({ RATE_LIMIT_START_PER_MINUTE: 'lots' })).toThrow('RATE_LIMIT_START_PER_MINUTE');
    expect(() => loadConfig({ RATE_LIMIT_MESSAGES_PER_MINUTE: '-5' })).toThrow('RATE_LIMIT_MESSAGES_PER_MINUTE');
    expect(() => loadConfig({ TRUST_PROXY: 'true' })).toThrow('TRUST_PROXY');
    expect(() => loadConfig({ CORS_ORIGINS: '*' })).toThrow('CORS_ORIGINS');
  });

  it('exposes the rate limits on their own so route decorators can read them per request', () => {
    expect(loadRateLimits({ RATE_LIMIT_MESSAGES_PER_MINUTE: '3' })).toEqual({ perMinute: 600, startPerMinute: 10, messagesPerMinute: 3 });
  });
});
