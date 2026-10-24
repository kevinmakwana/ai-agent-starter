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

describe('LLM client config', () => {
  it('retries twice by default, lets max tokens stay unset, and validates overrides', () => {
    expect(loadConfig({})).toMatchObject({ llmMaxRetries: 2, llmMaxTokens: undefined });
    expect(loadConfig({ LLM_MAX_RETRIES: '0', LLM_MAX_TOKENS: '2048' })).toMatchObject({ llmMaxRetries: 0, llmMaxTokens: 2048 });
    expect(() => loadConfig({ LLM_MAX_RETRIES: '-1' })).toThrow('LLM_MAX_RETRIES');
    expect(() => loadConfig({ LLM_MAX_TOKENS: '0' })).toThrow('LLM_MAX_TOKENS');
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

describe('basic numeric config', () => {
  it('validates the step limit, port and mock delay instead of letting NaN through', () => {
    expect(loadConfig({ AGENT_MAX_STEPS: '5', API_PORT: '4000', MOCK_DELAY_MS: '0' })).toMatchObject({ maxSteps: 5, port: 4000, mockDelayMs: 0 });
    expect(() => loadConfig({ AGENT_MAX_STEPS: 'many' })).toThrow('AGENT_MAX_STEPS');
    expect(() => loadConfig({ AGENT_MAX_STEPS: '0' })).toThrow('AGENT_MAX_STEPS');
    expect(() => loadConfig({ API_PORT: 'http' })).toThrow('API_PORT');
    expect(() => loadConfig({ API_PORT: '70000' })).toThrow('API_PORT');
    expect(() => loadConfig({ MOCK_DELAY_MS: '-1' })).toThrow('MOCK_DELAY_MS');
  });
});

describe('approval policy config', () => {
  it('always reviews by default, accepts dollars and cents, and rejects junk', () => {
    expect(loadConfig({}).approvalPolicy).toEqual({ refundAutoApproveUnder: 0 });
    expect(loadConfig({ REFUND_AUTO_APPROVE_UNDER: '' }).approvalPolicy.refundAutoApproveUnder).toBe(0);
    expect(loadConfig({ REFUND_AUTO_APPROVE_UNDER: '25' }).approvalPolicy.refundAutoApproveUnder).toBe(25);
    expect(loadConfig({ REFUND_AUTO_APPROVE_UNDER: '24.99' }).approvalPolicy.refundAutoApproveUnder).toBe(24.99);
    for (const bad of ['-1', 'lots', '10.005', 'Infinity', 'NaN']) {
      expect(() => loadConfig({ REFUND_AUTO_APPROVE_UNDER: bad })).toThrow('REFUND_AUTO_APPROVE_UNDER');
    }
  });
});

describe('stream limits config', () => {
  it('defaults to 5 per conversation and 20 for the reviewer, and validates overrides', () => {
    expect(loadConfig({}).streams).toEqual({ perConversation: 5, reviewer: 20 });
    expect(loadConfig({ STREAM_MAX_PER_CONVERSATION: '2', STREAM_MAX_REVIEWER: '3' }).streams).toEqual({ perConversation: 2, reviewer: 3 });
    expect(() => loadConfig({ STREAM_MAX_PER_CONVERSATION: '0' })).toThrow('STREAM_MAX_PER_CONVERSATION');
    expect(() => loadConfig({ STREAM_MAX_REVIEWER: 'many' })).toThrow('STREAM_MAX_REVIEWER');
  });
});
