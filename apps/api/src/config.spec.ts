import { loadConfig } from './config';

describe('loadConfig', () => {
  it('runs with zero configuration (offline mock provider)', () => {
    const cfg = loadConfig({});
    expect(cfg).toMatchObject({ provider: 'mock', port: 3001, maxSteps: 8 });
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
