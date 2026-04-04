import type { Provider } from '../types.js';

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

// ============== PROVIDER REGISTRY ==============
// Note: Voice providers (openai-voice, grok-voice) stay in the main API
// since they require direct WebSocket connections.

export const providers: Record<string, Provider> = {
  google: googleProvider,
  groq: groqProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  cerebras: cerebrasProvider,
  together: togetherProvider,
  replicate: replicateProvider,
  openrouter: openrouterProvider,
  mistral: mistralProvider,
  cloudflare: cloudflareProvider,
  deepseek: deepseekProvider,
  cohere: cohereProvider,
};

export function getProvider(name: string): Provider | undefined {
  return providers[name];
}

export function listProviders(): string[] {
  return Object.keys(providers);
}
