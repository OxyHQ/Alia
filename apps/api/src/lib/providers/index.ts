import type { Provider } from '../types';

import { googleProvider } from './google';
import { groqProvider } from './groq';
import { openaiProvider } from './openai';
import { cerebrasProvider } from './cerebras';
import { togetherProvider } from './together';

// ============== REGISTRO DE PROVEEDORES ==============
// Añadir nuevos proveedores aquí
export const providers: Record<string, Provider> = {
  google: googleProvider,
  groq: groqProvider,
  openai: openaiProvider,
  cerebras: cerebrasProvider,
  together: togetherProvider,
};

export function getProvider(name: string): Provider | undefined {
  return providers[name];
}

export function listProviders(): string[] {
  return Object.keys(providers);
}
