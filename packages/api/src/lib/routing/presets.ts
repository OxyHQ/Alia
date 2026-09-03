/**
 * Routing presets — Alia's product configuration for how a request is routed.
 *
 * #139 workstream 14 asks for "Alia-owned routing presets in product
 * configuration, not hard-coded provider maps". This file is the configuration.
 * It is deliberately NOT a provider map: no provider name, no upstream model id
 * and no ranking appears below. Those live in
 * `internal/providers/lib/generate-model-mappings.ts` and, per ADR 0001, are on
 * their way out of this repository entirely.
 *
 * ## What a preset is
 *
 * The thirteen canonical `kaana-*` identifiers are routing profiles rather
 * than concrete model references. Each selects a local `profile:<tier>` policy
 * preset; the internal policy ID is never a wire identifier.
 *
 * Twelve presets cover thirteen canonical Kaana profiles: `kaana-v1-thinking` and
 * `kaana-v1-pro-max` carry the same tier, so they are two names for one policy —
 * the case ADR 0002 describes as a reasoning setting wearing a model's name.
 *
 * ## What a preset controls TODAY, and what it will delegate
 *
 * `fallbackPolicy` is the only one of workstream 14's ROUTING concerns Alia can
 * enforce without Kaana. The rest are named in `DELEGATED_TO_KAANA` rather than
 * stubbed: a preset field that silently does nothing is worse than an absent
 * one, because the next reader assumes it works. Every field below is read by
 * something, and the doc on each one names what.
 *
 * ## Product policy facts
 *
 * Credit multiplier, token ceiling and category are declared here and read
 * from here. Canonical `kaana-*`
 * routing-profile IDs select the policy without borrowing identity from a
 * provider record or prompt filename.
 *
 * Region and data-policy restrictions, provider allow/deny and same-revision
 * deployment fallback all require a catalogue that knows which deployment is
 * where and who operates it. Alia has no such catalogue and ADR 0003 invariant
 * 4 puts deployment fallback on Kaana's side of the line, so no shape for them
 * is invented here. When the Kaana contract exists, they become fields on
 * `RoutingPreset` and travel with the request.
 *
 * ## Every preset's policy is `cross-model`, and that is the point
 *
 * Not an oversight: cross-model substitution across publishers is precisely
 * what the fallback engine does today, for every routing profile, and this change makes
 * that expressible without changing it. The frozen table in
 * `routing-policy.test.ts` fails if any entry narrows, so tightening a profile
 * is a deliberate, reviewable act rather than a quiet default flip for whoever
 * was using that profile.
 */

import type { ModelCategory } from '../gateway-client.js';
import type { KaanaRoutingProfileId } from './kaana-profiles.js';
import { DEFAULT_FALLBACK_POLICY, type FallbackPolicy } from './policy.js';

/**
 * A routing concern workstream 14 lists that Alia does not implement and must
 * not implement locally.
 *
 * `provider-allow-deny` is the sharpest of the four: the workstream's own
 * wording is "support provider allow/deny policy ONLY through the Oxy/Kaana
 * routing contract", so an Alia-side implementation would be the violation, not
 * the feature.
 */
export const DELEGATED_TO_KAANA = [
  'region',
  'data-policy',
  'provider-allow-deny',
  'same-revision-deployment-fallback',
] as const;

export type DelegatedRoutingConcern = (typeof DELEGATED_TO_KAANA)[number];

export interface RoutingPreset {
  /**
   * The profile's identity, in Alia's own namespace.
   *
   * ADR 0003's routing-profile identity rule: never `<publisher>/<model>` form,
   * because a profile references models and never is one. The `profile:` prefix
   * is what makes that unambiguous to a client.
   */
  readonly id: `profile:${string}`;
  /** Explicit primary identity; array order is never routing authority. */
  readonly primaryProfileId: KaanaRoutingProfileId;
  /** The canonical Kaana routing-profile identifiers selecting this preset. */
  readonly profileIds: readonly KaanaRoutingProfileId[];
  /** The tier whose ranked candidate list this preset routes over. */
  readonly tier: string;
  /** Enforced by the fallback engine on every request that selects this preset. */
  readonly fallbackPolicy: FallbackPolicy;
  /**
   * What a turn on this profile costs, relative to the base rate.
   *
   * Read by `lib/credits-manager.ts` on every billed request and published by
   * `lib/catalogue.ts`. It is a property of the
   * POLICY and not of the model that answered — `lib/routing/model-selection.ts`
   * explains at length why that is sound, and it is the reason a request naming
   * `<publisher>/<model>` is priced through the profile that model is homed
   * under rather than through a price of its own.
   */
  readonly creditMultiplier: number;
  /**
   * The historical output ceiling registered for this profile.
   *
   * Stated rather than enforced, and that is worth knowing before relying on
   * it: Alia publishes the value but does not turn it into a Kaana route or
   * provider limit. It remains historical product metadata until the shared
   * inference contract carries an enforceable ceiling.
   */
  readonly maxTokens: number;
  /**
   * Which surfaces may offer this profile — `lib/catalogue.ts`'s
   * `surfaceCanOffer` — and how `lib/routing/model-selection.ts` labels the
   * models homed under it.
   *
   * One value for the profile, which is what both readers already resolved: an
   * entry is built from the primary Kaana profile, so `profile:v1-pro-max` has always
   * been served as `general`. Its other identifier, `kaana-v1-thinking`,
   * registers `coding` on its own record. That divergence is pinned in `routing-policy.test.ts`
   * rather than resolved here: it is one identifier's presentation, and this
   * change is not the place to alter what an operator sees.
   */
  readonly category: ModelCategory;
}

/**
 * The preset table.
 *
 * Written out per entry rather than generated from `KAANA_ROUTING_PROFILES`, on purpose:
 * generating it would make this file a view of the provider map, which is the
 * thing workstream 14 asks it not to be. Drift is prevented by assertion
 * instead — `routing-policy.test.ts` checks this table against both the live
 * canonical Kaana profile set, in both directions.
 */
export const ROUTING_PRESETS: readonly RoutingPreset[] = [
  {
    id: 'profile:lite',
    primaryProfileId: 'kaana-lite',
    profileIds: ['kaana-lite'],
    tier: 'lite',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 0.5,
    maxTokens: 4096,
    category: 'general',
  },
  {
    id: 'profile:v1',
    primaryProfileId: 'kaana-v1',
    profileIds: ['kaana-v1'],
    tier: 'v1',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 1,
    maxTokens: 8192,
    category: 'general',
  },
  {
    id: 'profile:v1-codea',
    primaryProfileId: 'kaana-v1-codea',
    profileIds: ['kaana-v1-codea'],
    tier: 'v1-codea',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 1.5,
    maxTokens: 16384,
    category: 'coding',
  },
  {
    id: 'profile:v1-cowork',
    primaryProfileId: 'kaana-v1-cowork',
    profileIds: ['kaana-v1-cowork'],
    tier: 'v1-cowork',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 1.5,
    maxTokens: 16384,
    category: 'coding',
  },
  {
    id: 'profile:v1-browser',
    primaryProfileId: 'kaana-v1-browser',
    profileIds: ['kaana-v1-browser'],
    tier: 'v1-browser',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 1.5,
    maxTokens: 16384,
    category: 'coding',
  },
  {
    id: 'profile:v1-vision',
    primaryProfileId: 'kaana-v1-vision',
    profileIds: ['kaana-v1-vision'],
    tier: 'v1-vision',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 1.5,
    maxTokens: 16384,
    category: 'vision',
  },
  {
    id: 'profile:v1-audio',
    primaryProfileId: 'kaana-v1-audio',
    profileIds: ['kaana-v1-audio'],
    tier: 'v1-audio',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 1.0,
    maxTokens: 8192,
    category: 'audio',
  },
  {
    id: 'profile:v1-multimodal',
    primaryProfileId: 'kaana-v1-multimodal',
    profileIds: ['kaana-v1-multimodal'],
    tier: 'v1-multimodal',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 2.0,
    maxTokens: 32768,
    category: 'multimodal',
  },
  {
    id: 'profile:v1-pro',
    primaryProfileId: 'kaana-v1-pro',
    profileIds: ['kaana-v1-pro'],
    tier: 'v1-pro',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 3,
    maxTokens: 32768,
    category: 'coding',
  },
  {
    id: 'profile:v1-pro-max',
    primaryProfileId: 'kaana-v1-pro-max',
    // Two identifiers, one policy. Both are live and a caller may hold either.
    profileIds: ['kaana-v1-pro-max', 'kaana-v1-thinking'],
    tier: 'v1-pro-max',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 5,
    maxTokens: 128000,
    // The canonical identifier's, which is what every profile reader already
    // resolved. `kaana-v1-thinking` registers `coding`; see `category` above.
    category: 'general',
  },
  {
    id: 'profile:v1-voice',
    primaryProfileId: 'kaana-v1-voice',
    profileIds: ['kaana-v1-voice'],
    tier: 'v1-voice',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 2.0,
    maxTokens: 8192,
    category: 'voice',
  },
  {
    id: 'profile:v1-voice-pro',
    primaryProfileId: 'kaana-v1-voice-pro',
    profileIds: ['kaana-v1-voice-pro'],
    tier: 'v1-voice-pro',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 4.0,
    maxTokens: 32768,
    category: 'voice',
  },
];

/** Canonical Kaana routing profile → local policy preset, built once. */
const PRESET_BY_PROFILE: ReadonlyMap<string, RoutingPreset> = new Map(
  ROUTING_PRESETS.flatMap((preset) => preset.profileIds.map((profileId) => [profileId, preset] as const)),
);

/**
 * The preset a model identifier selects, or `null` when nothing does.
 *
 * `null` rather than a default preset. Falling back to one here would put the
 * silent rewrite back three files further up — the caller decides what an
 * unregistered identifier means, and every caller in this repository decides it
 * is an error.
 */
export function getRoutingPreset(profileId: string): RoutingPreset | null {
  return PRESET_BY_PROFILE.get(profileId) ?? null;
}
