import {
  KAANA_ROUTING_PROFILE_IDS,
  type KaanaRoutingProfileId,
} from './routing/kaana-profiles.js';

/** Product-owned prompt names, deliberately independent of inference IDs. */
export const PRODUCT_PROMPT_BY_KAANA_PROFILE = {
  'route:instant': 'general-lite',
  'route:auto': 'general',
  'route:code': 'codea',
  'route:cowork': 'cowork',
  'route:research': 'browser',
  'route:vision': 'vision',
  'route:audio': 'audio',
  'route:multimodal': 'multimodal',
  'route:pro-standard': 'codea-pro',
  'route:thinking': 'extended-reasoning',
  'route:pro': 'pro-max',
  'route:voice': 'voice',
  'route:voice-pro': 'voice-pro',
} as const satisfies Record<KaanaRoutingProfileId, string>;

export type ProductPromptId = (typeof PRODUCT_PROMPT_BY_KAANA_PROFILE)[KaanaRoutingProfileId];

/** The product prompt for a canonical Kaana profile, or null for another ID. */
export function getProductPromptId(profileId: string): ProductPromptId | null {
  if (!Object.hasOwn(PRODUCT_PROMPT_BY_KAANA_PROFILE, profileId)) return null;
  return PRODUCT_PROMPT_BY_KAANA_PROFILE[profileId as KaanaRoutingProfileId];
}

/** Exact coverage, exported for runtime-data and architecture gates. */
export const PRODUCT_PROMPT_PROFILE_IDS: readonly KaanaRoutingProfileId[] = KAANA_ROUTING_PROFILE_IDS;
