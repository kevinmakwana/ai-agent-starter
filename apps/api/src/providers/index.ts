import type { AppConfig } from '../config';
import type { ChatProvider } from '../agent/types';
import { AnthropicProvider } from './anthropic.provider';
import { MockProvider } from './mock.provider';
import { OpenAiProvider } from './openai.provider';

export function createProvider(cfg: AppConfig): ChatProvider {
  switch (cfg.provider) {
    case 'openai':
      return new OpenAiProvider(cfg.openai);
    case 'anthropic':
      return new AnthropicProvider(cfg.anthropic);
    default:
      return new MockProvider(cfg.mockDelayMs);
  }
}
