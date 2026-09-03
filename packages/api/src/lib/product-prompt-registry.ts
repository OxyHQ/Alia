import {
  KAANA_ROUTING_PROFILE_IDS,
  type KaanaRoutingProfileId,
} from './routing/kaana-profiles.js';

/** Product-owned prompt names, deliberately independent of inference IDs. */
export const PRODUCT_PROMPT_BY_KAANA_PROFILE = {
  'kaana-lite': 'general-lite',
  'kaana-v1': 'general',
  'kaana-v1-codea': 'codea',
  'kaana-v1-cowork': 'cowork',
  'kaana-v1-browser': 'browser',
  'kaana-v1-vision': 'vision',
  'kaana-v1-audio': 'audio',
  'kaana-v1-multimodal': 'multimodal',
  'kaana-v1-pro': 'codea-pro',
  'kaana-v1-thinking': 'extended-reasoning',
  'kaana-v1-pro-max': 'pro-max',
  'kaana-v1-voice': 'voice',
  'kaana-v1-voice-pro': 'voice-pro',
} as const satisfies Record<KaanaRoutingProfileId, string>;

export type ProductPromptId = (typeof PRODUCT_PROMPT_BY_KAANA_PROFILE)[KaanaRoutingProfileId];

/** The product prompt for a canonical Kaana profile, or null for another ID. */
export function getProductPromptId(profileId: string): ProductPromptId | null {
  if (!Object.hasOwn(PRODUCT_PROMPT_BY_KAANA_PROFILE, profileId)) return null;
  return PRODUCT_PROMPT_BY_KAANA_PROFILE[profileId as KaanaRoutingProfileId];
}

/** Exact coverage, exported for runtime-data and architecture gates. */
export const PRODUCT_PROMPT_PROFILE_IDS: readonly KaanaRoutingProfileId[] = KAANA_ROUTING_PROFILE_IDS;
