import type { KaanaRoutingProfileId } from '../lib/routing/kaana-profiles.js';

/**
 * Permanent Oxy catalogue primary keys reserved by the reviewed Kaana
 * bootstrap. Product profile slugs stop at this boundary: Oxy receives only
 * the exact opaque ID, never a name lookup or an insertion-order choice.
 *
 * Keep this map byte-for-byte aligned with
 * `OxyHQServices/packages/api/src/config/kaanaInitialCatalogue.ts`.
 */
export const OXY_KAANA_ROUTING_PROFILE_IDS = {
  'kaana-lite': '01a06477-94f5-74f0-bc25-4a1ff59d6945',
  'kaana-v1': '01a06477-94f5-74f0-bc25-4c5c13b93ccd',
  'kaana-v1-codea': '01a06477-94f5-74f0-bc25-52437e0c724d',
  'kaana-v1-cowork': '01a06477-94f5-74f0-bc25-55ea2ebdb2b6',
  'kaana-v1-browser': '01a06477-94f5-74f0-bc25-5a78baecbef6',
  'kaana-v1-pro': '01a06477-94f5-74f0-bc25-5d796b49b616',
  'kaana-v1-thinking': '01a06477-94f5-74f0-bc25-628b5f45d802',
  'kaana-v1-pro-max': '01a06477-94f5-74f0-bc25-658eeb277737',
} as const satisfies Partial<Record<KaanaRoutingProfileId, string>>;

export type OxyKaanaProductProfileId = keyof typeof OXY_KAANA_ROUTING_PROFILE_IDS;
export type OxyKaanaRoutingProfileId =
  (typeof OXY_KAANA_ROUTING_PROFILE_IDS)[OxyKaanaProductProfileId];

function isOxyKaanaProductProfileId(value: string): value is OxyKaanaProductProfileId {
  return Object.prototype.hasOwnProperty.call(OXY_KAANA_ROUTING_PROFILE_IDS, value);
}

/** Exact, closed lookup. Unsupported or unknown product profiles never fall back. */
export function getOxyKaanaRoutingProfileId(
  productProfileId: string,
): OxyKaanaRoutingProfileId | null {
  return isOxyKaanaProductProfileId(productProfileId)
    ? OXY_KAANA_ROUTING_PROFILE_IDS[productProfileId]
    : null;
}
