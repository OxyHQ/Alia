/**
 * The routing profiles Alia may ask Kaana to execute.
 *
 * These identifiers are canonical routing-profile slugs. They are not model
 * identities, provider aliases, compatibility spellings, or prompt filenames.
 * Kaana owns what each profile routes to; Alia owns only which profile its
 * product surfaces request.
 */
export const KAANA_ROUTING_PROFILE_IDS = [
  'kaana-lite',
  'kaana-v1',
  'kaana-v1-codea',
  'kaana-v1-cowork',
  'kaana-v1-browser',
  'kaana-v1-vision',
  'kaana-v1-audio',
  'kaana-v1-multimodal',
  'kaana-v1-pro',
  'kaana-v1-thinking',
  'kaana-v1-pro-max',
  'kaana-v1-voice',
  'kaana-v1-voice-pro',
] as const;

export type KaanaRoutingProfileId = (typeof KAANA_ROUTING_PROFILE_IDS)[number];

const KAANA_ROUTING_PROFILES: ReadonlySet<string> = new Set(KAANA_ROUTING_PROFILE_IDS);

export function isKaanaRoutingProfileId(value: unknown): value is KaanaRoutingProfileId {
  return typeof value === 'string' && KAANA_ROUTING_PROFILES.has(value);
}
