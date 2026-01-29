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
import { grokVoiceProvider } from './grok-voice';

// ============== REGISTRO DE PROVEEDORES ==============
// Añadir nuevos proveedores aquí
export const providers: Record<string, Provider | VoiceProvider> = {
  google: googleProvider,
  groq: groqProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  cerebras: cerebrasProvider,
  together: togetherProvider,
  openrouter: openrouterProvider,
  mistral: mistralProvider,
  cloudflare: cloudflareProvider,
  deepseek: deepseekProvider,
  grok: grokVoiceProvider,
};

export function getProvider(name: string): Provider | VoiceProvider | undefined {
  return providers[name];
}

export function listProviders(): string[] {
  return Object.keys(providers);
}
