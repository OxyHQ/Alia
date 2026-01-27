import type { Provider } from '../types';

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

// ============== REGISTRO DE PROVEEDORES ==============
// Añadir nuevos proveedores aquí
export const providers: Record<string, Provider> = {
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
};

export function getProvider(name: string): Provider | undefined {
  return providers[name];
}

export function listProviders(): string[] {
  return Object.keys(providers);
}
