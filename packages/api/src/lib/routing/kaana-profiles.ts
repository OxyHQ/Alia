/**
 * The routing profiles Alia may ask Kaana to execute.
 *
 * These identifiers are canonical routing-profile slugs. They are not model
 * identities, provider aliases, compatibility spellings, or prompt filenames.
 * Kaana owns what each profile routes to; Alia owns only which profile its
 * product surfaces request.
 */
export const KAANA_ROUTING_PROFILE_IDS = [
  'route:instant',
  'route:auto',
  'route:code',
  'route:cowork',
  'route:research',
  'route:vision',
  'route:audio',
  'route:multimodal',
  'route:pro-standard',
  'route:thinking',
  'route:pro',
  'route:voice',
  'route:voice-pro',
] as const;

export type KaanaRoutingProfileId = (typeof KAANA_ROUTING_PROFILE_IDS)[number];

const KAANA_ROUTING_PROFILES: ReadonlySet<string> = new Set(KAANA_ROUTING_PROFILE_IDS);

export function isKaanaRoutingProfileId(value: unknown): value is KaanaRoutingProfileId {
  return typeof value === 'string' && KAANA_ROUTING_PROFILES.has(value);
}
