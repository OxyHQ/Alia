import type { Provider } from '../types.js';

import { googleProvider } from './google.js';
import { groqProvider } from './groq.js';
import { openaiProvider } from './openai.js';
import { anthropicProvider } from './anthropic.js';
import { cerebrasProvider } from './cerebras.js';
import { togetherProvider } from './together.js';
import { openrouterProvider } from './openrouter.js';
import { mistralProvider } from './mistral.js';
import { cloudflareProvider } from './cloudflare.js';
import { deepseekProvider } from './deepseek.js';
import { replicateProvider } from './replicate.js';
import { cohereProvider } from './cohere.js';

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
