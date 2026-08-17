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
import { xaiProvider } from './xai';
import { fireworksProvider } from './fireworks';
import { perplexityProvider } from './perplexity';
import { sambanovaProvider } from './sambanova';
import { hyperbolicProvider } from './hyperbolic';
import { novitaProvider } from './novita';
import { digitaloceanProvider } from './digitalocean';

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
  // xAI supports both text chat (proxy) and realtime voice
  xai: { ...xaiProvider, voice: grokVoiceProvider.voice } as CombinedProvider,
  fireworks: fireworksProvider,
  perplexity: perplexityProvider,
  sambanova: sambanovaProvider,
  hyperbolic: hyperbolicProvider,
  novita: novitaProvider,
  digitalocean: digitaloceanProvider,
};

export function getProvider(name: string): Provider | VoiceProvider | undefined {
  // The `undefined` in this signature is the whole contract, and an object
  // literal cannot honour it: `providers['constructor']` is the `Object`
  // constructor, so the one answer callers branch on was unreachable for five
  // names. Not reachable from a request today — `name` comes from a mapping
  // row — which is why it is a correctness fix rather than a security one.
  return Object.hasOwn(providers, name) ? providers[name] : undefined;
}

export function listProviders(): string[] {
  return Object.keys(providers);
}
