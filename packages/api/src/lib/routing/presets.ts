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
 * `docs/migration/alias-migration-map.json` (#139 workstream 4) measured every
 * one of the thirteen `alia-*` identifiers and classified all thirteen as
 * ROUTING PROFILES rather than concrete model references, each identified as
 * `profile:<tier>` because the tier IS the policy. This table is the Alia-side
 * object those profile ids name. It is keyed by the same ids and asserted equal
 * to that file in `routing-policy.test.ts`, so the two cannot drift.
 *
 * Twelve presets cover thirteen aliases: `alia-v1-thinking` and
 * `alia-v1-pro-max` carry the same tier, so they are two names for one policy —
 * the case ADR 0002 describes as a reasoning setting wearing a model's name.
 *
 * ## What a preset controls TODAY, and what it will delegate
 *
 * Only `fallbackPolicy` is enforced here, because it is the only one of
 * workstream 14's routing concerns that Alia can enforce without Relay. The
 * rest are named in `DELEGATED_TO_RELAY` rather than stubbed: a preset field
 * that silently does nothing is worse than an absent one, because the next
 * reader assumes it works.
 *
 * Region and data-policy restrictions, provider allow/deny and same-revision
 * deployment fallback all require a catalogue that knows which deployment is
 * where and who operates it. Alia has no such catalogue and ADR 0003 invariant
 * 4 puts deployment fallback on Relay's side of the line, so no shape for them
 * is invented here. When the Relay contract exists, they become fields on
 * `RoutingPreset` and travel with the request.
 *
 * ## Every preset's policy is `cross-model`, and that is the point
 *
 * Not an oversight: cross-model substitution across publishers is precisely
 * what the fallback engine does today, for every alias, and this change makes
 * that expressible without changing it. The frozen table in
 * `routing-policy.test.ts` fails if any entry narrows, so tightening a profile
 * is a deliberate, reviewable act rather than a quiet default flip for whoever
 * was using that profile.
 */

import { DEFAULT_FALLBACK_POLICY, type FallbackPolicy } from './policy.js';

/**
 * A routing concern workstream 14 lists that Alia does not implement and must
 * not implement locally.
 *
 * `provider-allow-deny` is the sharpest of the four: the workstream's own
 * wording is "support provider allow/deny policy ONLY through the Oxy/Relay
 * routing contract", so an Alia-side implementation would be the violation, not
 * the feature.
 */
export const DELEGATED_TO_RELAY = [
  'region',
  'data-policy',
  'provider-allow-deny',
  'same-revision-deployment-fallback',
] as const;

export type DelegatedRoutingConcern = (typeof DELEGATED_TO_RELAY)[number];

export interface RoutingPreset {
  /**
   * The profile's identity, in Alia's own namespace.
   *
   * ADR 0003's routing-profile identity rule: never `<publisher>/<model>` form,
   * because a profile references models and never is one. The `profile:` prefix
   * is what makes that unambiguous to a client.
   */
  readonly id: `profile:${string}`;
  /** The `alia-*` identifiers a caller may name to select this preset. */
  readonly aliases: readonly string[];
  /** The tier whose ranked candidate list this preset routes over. */
  readonly tier: string;
  /** Enforced by the fallback engine on every request that selects this preset. */
  readonly fallbackPolicy: FallbackPolicy;
}

/**
 * The preset table.
 *
 * Written out per entry rather than generated from `ALIA_MODELS`, on purpose:
 * generating it would make this file a view of the provider map, which is the
 * thing workstream 14 asks it not to be. Drift is prevented by assertion
 * instead — `routing-policy.test.ts` checks this table against both the live
 * alias set and the migration map, in both directions.
 */
export const ROUTING_PRESETS: readonly RoutingPreset[] = [
  { id: 'profile:lite', aliases: ['alia-lite'], tier: 'lite', fallbackPolicy: DEFAULT_FALLBACK_POLICY },
  { id: 'profile:v1', aliases: ['alia-v1'], tier: 'v1', fallbackPolicy: DEFAULT_FALLBACK_POLICY },
  { id: 'profile:v1-codea', aliases: ['alia-v1-codea'], tier: 'v1-codea', fallbackPolicy: DEFAULT_FALLBACK_POLICY },
  { id: 'profile:v1-cowork', aliases: ['alia-v1-cowork'], tier: 'v1-cowork', fallbackPolicy: DEFAULT_FALLBACK_POLICY },
  { id: 'profile:v1-browser', aliases: ['alia-v1-browser'], tier: 'v1-browser', fallbackPolicy: DEFAULT_FALLBACK_POLICY },
  { id: 'profile:v1-vision', aliases: ['alia-v1-vision'], tier: 'v1-vision', fallbackPolicy: DEFAULT_FALLBACK_POLICY },
  { id: 'profile:v1-audio', aliases: ['alia-v1-audio'], tier: 'v1-audio', fallbackPolicy: DEFAULT_FALLBACK_POLICY },
  { id: 'profile:v1-multimodal', aliases: ['alia-v1-multimodal'], tier: 'v1-multimodal', fallbackPolicy: DEFAULT_FALLBACK_POLICY },
  { id: 'profile:v1-pro', aliases: ['alia-v1-pro'], tier: 'v1-pro', fallbackPolicy: DEFAULT_FALLBACK_POLICY },
  {
    id: 'profile:v1-pro-max',
    // Two identifiers, one policy. Both are live and a caller may hold either.
    aliases: ['alia-v1-pro-max', 'alia-v1-thinking'],
    tier: 'v1-pro-max',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
  },
  { id: 'profile:v1-voice', aliases: ['alia-v1-voice'], tier: 'v1-voice', fallbackPolicy: DEFAULT_FALLBACK_POLICY },
  { id: 'profile:v1-voice-pro', aliases: ['alia-v1-voice-pro'], tier: 'v1-voice-pro', fallbackPolicy: DEFAULT_FALLBACK_POLICY },
];

/** Alias → preset, built once. */
const PRESET_BY_ALIAS: ReadonlyMap<string, RoutingPreset> = new Map(
  ROUTING_PRESETS.flatMap((preset) => preset.aliases.map((alias) => [alias, preset] as const)),
);

/**
 * The preset a model identifier selects, or `null` when nothing does.
 *
 * `null` rather than a default preset. Falling back to one here would put the
 * silent rewrite back three files further up — the caller decides what an
 * unregistered identifier means, and every caller in this repository decides it
 * is an error.
 */
export function getRoutingPreset(aliasModelId: string): RoutingPreset | null {
  return PRESET_BY_ALIAS.get(aliasModelId) ?? null;
}
