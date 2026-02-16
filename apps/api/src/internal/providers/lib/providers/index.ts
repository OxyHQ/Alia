import type { Provider } from '../types';
import type { VoiceProvider } from '../types-voice';

import { googleProvider } from './google';
import { groqProvider } from './groq';
import { openaiProvider } from './openai';
import { anthropicProvider } from './anthropic';
import { cerebrasProvider } from './cerebras';
import { togetherProvider } from './together';
import { openrouterProvider } from './openrouter';
import { mistralProvider } from './mistral';
import { cloudflareProvider } from './cloudflare';
import { deepseekProvider } from './deepseek';
import { replicateProvider } from './replicate';
import { cohereProvider } from './cohere';
import { grokVoiceProvider } from './grok-voice';
import { openaiVoiceProvider } from './openai-voice';

// ============== PROVIDER REGISTRY ==============

// Combined provider type: text (proxy) + voice capabilities on a single key
type CombinedProvider = Provider & Pick<VoiceProvider, 'voice'>;

export const providers: Record<string, Provider | VoiceProvider | CombinedProvider> = {
  google: googleProvider,
  groq: groqProvider,
  // OpenAI supports both text chat (proxy) and realtime voice
  openai: { ...openaiProvider, voice: openaiVoiceProvider.voice } as CombinedProvider,
  anthropic: anthropicProvider,
  cerebras: cerebrasProvider,
  together: togetherProvider,
  replicate: replicateProvider,
  openrouter: openrouterProvider,
  mistral: mistralProvider,
  cloudflare: cloudflareProvider,
  deepseek: deepseekProvider,
  cohere: cohereProvider,
  xai: grokVoiceProvider,
};

export function getProvider(name: string): Provider | VoiceProvider | undefined {
  return providers[name];
}

export function listProviders(): string[] {
  return Object.keys(providers);
}
