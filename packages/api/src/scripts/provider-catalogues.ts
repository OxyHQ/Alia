/**
 * Which providers this repo can ask "what do you serve today", and how.
 *
 * Separate from the script that uses it so the tables can be gated: a provider
 * that appears in the routing table and in neither of these is one whose models
 * nobody is checking, and `provider-catalogues.test.ts` fails on it.
 */

import { PROVIDER_API_HOSTS } from '../lib/inference/provider-egress-policy.js';

/**
 * The path each provider serves its catalogue on. The HOST is not repeated here
 * — it comes from `PROVIDER_API_HOSTS`, the map the egress policy already
 * enforces — so this table cannot name a host the deployment would refuse to
 * dial, and a host change has one place to happen.
 *
 * The paths mirror the base URLs `chat-core.ts` builds its clients from, which
 * is why several are not `/v1/models`.
 */
export const CATALOGUE_PATHS: Readonly<Record<string, string>> = {
  openai: '/v1/models',
  anthropic: '/v1/models',
  groq: '/openai/v1/models',
  mistral: '/v1/models',
  deepseek: '/models',
  together: '/v1/models',
  cerebras: '/v1/models',
  openrouter: '/api/v1/models',
  cohere: '/compatibility/v1/models',
  fireworks: '/inference/v1/models',
  perplexity: '/models',
  xai: '/v1/models',
  sambanova: '/v1/models',
  hyperbolic: '/v1/models',
  novita: '/v3/openai/models',
  digitalocean: '/v1/models',
  cheaperinference: '/v1/models',
};

/** Operators with no catalogue endpoint this script can read, and why. */
export const NO_CATALOGUE: Readonly<Record<string, string>> = {
  google: 'Its catalogue is the Generative Language API, which answers a different shape under a query-string key rather than a bearer token.',
  cloudflare: 'Model ids are account-scoped Workers AI paths; listing them needs the account id as well as the token.',
  replicate: 'Models are owner/name pairs with versions, not a flat id list; a mapping names a version that outlives the id.',
  elevenlabs: 'It has a model list, but behind `xi-api-key` rather than the bearer token `sync-provider-models.ts` sends — the same reason google is here, arrived at the same way.',
};

/** `null` when this script has no way to ask that provider. */
export function catalogueUrlFor(provider: string): string | null {
  // `Object.hasOwn` rather than a bare read: `CATALOGUE_PATHS['constructor']`
  // answers with `Object`'s constructor, and a provider name reaching here from
  // a routing row is not a literal.
  if (!Object.hasOwn(CATALOGUE_PATHS, provider) || !Object.hasOwn(PROVIDER_API_HOSTS, provider)) {
    return null;
  }
  return `https://${PROVIDER_API_HOSTS[provider]}${CATALOGUE_PATHS[provider]}`;
}

