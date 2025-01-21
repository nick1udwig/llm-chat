import { ProviderConfig } from '../../components/LlmChat/types/provider';
import { DeepSeekProvider } from './deepseek';

import { ProviderConfig } from '../../components/LlmChat/types/provider';
import { DeepSeekProvider } from './deepseek';
import EventEmitter from 'events';

export interface LLMProvider extends EventEmitter {
  sendMessage: DeepSeekProvider['sendMessage'];
  sendStreamingMessage: DeepSeekProvider['sendStreamingMessage'];
}

export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.type) {
    case 'deepseek':
      return new DeepSeekProvider(config);
    case 'anthropic':
      // Use existing Anthropic implementation
      throw new Error('Anthropic provider not yet migrated to new system');
    case 'openai':
      throw new Error('OpenAI provider not yet implemented');
    case 'openrouter':
      throw new Error('OpenRouter provider not yet implemented');
    default:
      throw new Error(`Unsupported provider type: ${config.type}`);
  }
}