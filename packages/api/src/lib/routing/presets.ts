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
 * `fallbackPolicy` is the only one of workstream 14's ROUTING concerns Alia can
 * enforce without Relay. The rest are named in `DELEGATED_TO_RELAY` rather than
 * stubbed: a preset field that silently does nothing is worse than an absent
 * one, because the next reader assumes it works. Every field below is read by
 * something, and the doc on each one names what.
 *
 * ## The product facts moved here from the alias record
 *
 * `product-modes.ts` used to state the dependency in the other direction: "the
 * alias still owns the metadata a request needs — the credit multiplier
 * `lib/credits-manager.ts` bills on, `maxTokens`, the category, and the system
 * prompt. Serving a profile means serving that alias's facts under the
 * profile's name." That is what made the thirteen `alia-*` identifiers
 * undeletable: de-advertising them (ADR 0003) removed them from
 * `GET /v1/models` and left every price hanging off `ALIA_MODELS`, including
 * the price of a request that named `<publisher>/<model>` and no alias at all.
 *
 * So the facts are declared here and read from here. The aliases still exist
 * and still resolve — nothing about routing changes, and `routing-policy.test.ts`
 * asserts every value below still equals the one on the alias record, in both
 * directions, so this table cannot drift from `ALIA_MODELS` while both exist.
 * That assertion retires with the alias layer; these values do not.
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

import type { ModelCategory } from '../gateway-client.js';
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
  /**
   * What a turn on this profile costs, relative to the base rate.
   *
   * Read by `lib/credits-manager.ts` on every billed request, and published by
   * `lib/catalogue.ts` and `routes/models-stats.ts`. It is a property of the
   * POLICY and not of the model that answered — `lib/routing/model-selection.ts`
   * explains at length why that is sound, and it is the reason a request naming
   * `<publisher>/<model>` is priced through the profile that model is homed
   * under rather than through a price of its own.
   */
  readonly creditMultiplier: number;
  /**
   * The output ceiling registered for this profile, published by
   * `routes/models-stats.ts`.
   *
   * Stated rather than enforced, and that is worth knowing before relying on
   * it: no provider adapter reads this number. Every one of them sends
   * `config?.maxTokens ?? 8192` and nothing sets `config.maxTokens` from a
   * profile, so what a request actually gets is 8192 unless the caller asked
   * otherwise. It moved here because it is the profile's registered figure and
   * it was the alias record's, not because wiring it up is part of this change.
   */
  readonly maxTokens: number;
  /**
   * Which surfaces may offer this profile — `lib/catalogue.ts`'s
   * `surfaceCanOffer` — and how `lib/routing/model-selection.ts` labels the
   * models homed under it.
   *
   * One value for the profile, which is what both readers already resolved: an
   * entry is built from the CANONICAL alias, so `profile:v1-pro-max` has always
   * been served as `general`. Its other identifier, `alia-v1-thinking`,
   * registers `coding` on its own record and `routes/models-stats.ts` still
   * lists it that way. That divergence is pinned in `routing-policy.test.ts`
   * rather than resolved here: it is one identifier's presentation, and this
   * change is not the place to alter what an operator sees.
   */
  readonly category: ModelCategory;
  /**
   * The `prompts/<name>.md` each of this profile's identifiers serves.
   *
   * Keyed by alias, because the prompt is the one fact that genuinely differs
   * between two names for one policy: `alia-v1-pro-max.md` is "the most
   * advanced tier available" and `alia-v1-thinking.md` is a page about when to
   * deliberate, which `lib/system-prompt-builder.ts` ALSO layers on as the
   * extended-reasoning fragment. Collapsing them would silently change what the
   * model is told.
   *
   * Every value is a file that exists today, and no file is renamed by this
   * change: `73ce422b` put `prompts/` in the runtime image, so a name that
   * moves here and not in the image degrades to an empty prompt rather than to
   * an error. `routing-policy.test.ts` checks each value against the directory.
   */
  readonly prompts: Readonly<Record<string, string>>;
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
  {
    id: 'profile:lite',
    aliases: ['alia-lite'],
    tier: 'lite',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 0.5,
    maxTokens: 4096,
    category: 'general',
    prompts: { 'alia-lite': 'alia-lite' },
  },
  {
    id: 'profile:v1',
    aliases: ['alia-v1'],
    tier: 'v1',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 1,
    maxTokens: 8192,
    category: 'general',
    prompts: { 'alia-v1': 'alia-v1' },
  },
  {
    id: 'profile:v1-codea',
    aliases: ['alia-v1-codea'],
    tier: 'v1-codea',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 1.5,
    maxTokens: 16384,
    category: 'coding',
    prompts: { 'alia-v1-codea': 'alia-v1-codea' },
  },
  {
    id: 'profile:v1-cowork',
    aliases: ['alia-v1-cowork'],
    tier: 'v1-cowork',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 1.5,
    maxTokens: 16384,
    category: 'coding',
    prompts: { 'alia-v1-cowork': 'alia-v1-cowork' },
  },
  {
    id: 'profile:v1-browser',
    aliases: ['alia-v1-browser'],
    tier: 'v1-browser',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 1.5,
    maxTokens: 16384,
    category: 'coding',
    prompts: { 'alia-v1-browser': 'alia-v1-browser' },
  },
  {
    id: 'profile:v1-vision',
    aliases: ['alia-v1-vision'],
    tier: 'v1-vision',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 1.5,
    maxTokens: 16384,
    category: 'vision',
    prompts: { 'alia-v1-vision': 'alia-v1-vision' },
  },
  {
    id: 'profile:v1-audio',
    aliases: ['alia-v1-audio'],
    tier: 'v1-audio',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 1.0,
    maxTokens: 8192,
    category: 'audio',
    prompts: { 'alia-v1-audio': 'alia-v1-audio' },
  },
  {
    id: 'profile:v1-multimodal',
    aliases: ['alia-v1-multimodal'],
    tier: 'v1-multimodal',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 2.0,
    maxTokens: 32768,
    category: 'multimodal',
    prompts: { 'alia-v1-multimodal': 'alia-v1-multimodal' },
  },
  {
    id: 'profile:v1-pro',
    aliases: ['alia-v1-pro'],
    tier: 'v1-pro',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 3,
    maxTokens: 32768,
    category: 'coding',
    prompts: { 'alia-v1-pro': 'alia-v1-pro' },
  },
  {
    id: 'profile:v1-pro-max',
    // Two identifiers, one policy. Both are live and a caller may hold either.
    aliases: ['alia-v1-pro-max', 'alia-v1-thinking'],
    tier: 'v1-pro-max',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 5,
    maxTokens: 128000,
    // The canonical identifier's, which is what every profile reader already
    // resolved. `alia-v1-thinking` registers `coding`; see `category` above.
    category: 'general',
    // The one preset whose two identifiers do NOT share a prompt.
    prompts: { 'alia-v1-pro-max': 'alia-v1-pro-max', 'alia-v1-thinking': 'alia-v1-thinking' },
  },
  {
    id: 'profile:v1-voice',
    aliases: ['alia-v1-voice'],
    tier: 'v1-voice',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 2.0,
    maxTokens: 8192,
    category: 'voice',
    prompts: { 'alia-v1-voice': 'alia-v1-voice' },
  },
  {
    id: 'profile:v1-voice-pro',
    aliases: ['alia-v1-voice-pro'],
    tier: 'v1-voice-pro',
    fallbackPolicy: DEFAULT_FALLBACK_POLICY,
    creditMultiplier: 4.0,
    maxTokens: 32768,
    category: 'voice',
    prompts: { 'alia-v1-voice-pro': 'alia-v1-voice-pro' },
  },
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

/**
 * The prompt file an identifier serves, or `null` when nothing registers one.
 *
 * `null` rather than the identifier itself, for the reason above: the caller
 * decides what an unregistered identifier means. `lib/system-prompt-builder.ts`
 * decides it means "load nothing model-specific and keep the base prompt",
 * which is what `loadPrompt` already did with a name it could not find — the
 * difference is that the decision is now visible at the call site instead of
 * being an ENOENT swallowed three files away.
 */
export function getPromptId(aliasModelId: string): string | null {
  const preset = PRESET_BY_ALIAS.get(aliasModelId);
  if (preset === undefined) return null;
  return Object.hasOwn(preset.prompts, aliasModelId) ? preset.prompts[aliasModelId] : null;
}
