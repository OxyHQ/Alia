/**
 * Canonical list of supported provider names for the API.
 * Import from here instead of hardcoding provider lists.
 */

export const PROVIDER_NAMES = [
  'openai',
  'anthropic',
  'google',
  'groq',
  'mistral',
  'deepseek',
  'together',
  'replicate',
  'cerebras',
  'cloudflare',
  'openrouter',
  'cohere',
  'fireworks',
  'perplexity',
  'xai',
  'sambanova',
  'hyperbolic',
  'novita',
  'digitalocean',
] as const;

export type ProviderName = typeof PROVIDER_NAMES[number];
