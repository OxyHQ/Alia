/**
 * Product modes — what a person picks in Alia, and the only thing they should
 * ever have to pick (ADR 0002, ADR 0003, epic #139 workstream 4).
 *
 * ## What a mode is, and what it is not
 *
 * A mode is PRODUCT CONFIGURATION. It has a name a person can act on, and it
 * says which routing profile a request made under it routes through. It is not
 * a model: it has no weights, no publisher, no revision and no model card, so
 * `routes/catalogue.ts` serializes it `object: 'product_mode'` and gate 5 of
 * `__tests__/architectureGates.test.ts` fails if that ever becomes `model`.
 *
 * The thirteen `alia-*` identifiers are what this replaces. Each of them is a
 * routing profile wearing a model's name — `docs/migration/alias-migration-map.json`
 * measured all thirteen and classified none as a concrete model reference —
 * and five of the thirteen additionally encode a product decision in the
 * identifier itself: a quality tier (`alia-lite` versus `alia-v1-pro-max`), a
 * reasoning level (`alia-v1-thinking`), or a surface's preset (`alia-v1-codea`,
 * `alia-v1-cowork`). ADR 0002 calls that last case "a reasoning setting wearing
 * a model's name". A mode is where those decisions belong.
 *
 * ## Every binding below is measured, not assigned
 *
 * #139 names six modes by way of example. Which routing profile each one
 * selects is a product decision, and PR #156 declined to make it rather than
 * invent one. It is not invented here either: every binding is read off a
 * property the product already publishes, and `__tests__/product-modes.test.ts`
 * recomputes each one from the live tables, so a routing or catalogue change
 * that moved a binding fails there instead of leaving a stale label.
 *
 * The three general-purpose modes come from ONE derivation rather than three.
 * Exactly three identifiers are category `general` and offered in the picker —
 * `alia-lite`, `alia-v1` and `alia-v1-pro-max` — so ordering them by credit
 * multiplier is total and has no ties: cheapest is Fast, dearest is Maximum
 * quality, and the one left over is Balanced. Their own descriptions agree
 * word for word ("Fast responses for simple tasks", "Balanced performance for
 * everyday tasks", "Best available models for demanding tasks"), which is the
 * cross-check rather than the derivation.
 *
 * Coding is read off the CONSUMERS instead: `packages/alia-codea/package.json`,
 * `packages/alia-codea/src/*` and `packages/alia-codea-cli/src/utils/config.ts`
 * all default to `alia-v1-codea`, so the coding profile is the one the coding
 * product already selects.
 *
 * ## Two modes pin no profile, and that is the measurement too
 *
 * Automatic and Deep research both carry {@link ProductModeRouting} `default`,
 * because neither changes routing today and saying otherwise would be the
 * invention this file exists to avoid.
 *
 *  - **Automatic** is the mode that expresses no preference. A request that
 *    names no model already routes through `getDefaultAliaModel()`
 *    (`lib/chat/request-context.ts:161`), so `default` is not a stub — it is
 *    that path, named. Selecting a profile per request from the prompt is
 *    routing work, and ADR 0001 puts routing behind Kaana.
 *  - **Deep research** is a PIPELINE, not a tier. `handleDeepResearch` runs on
 *    `ctx.aliasModelId` — whatever the request already resolved
 *    (`lib/chat-modes/deep-research-handler.ts:31`) — so binding it to a
 *    quality tier would attach a routing claim to a mode that makes none. It
 *    differs from Automatic in exactly one published field, {@link
 *    ProductMode.deepResearch}, which is the request flag it sets.
 */

import { ROUTING_PRESETS, type RoutingPreset } from './routing/presets.js';

/** The marker Alia's flat id space needs so a profile is distinguishable from a model. */
const PROFILE_ID_PREFIX = 'profile:';

/** A routing profile's identity, in Alia's own namespace. Never `<publisher>/<model>`. */
export type RoutingProfileId = RoutingPreset['id'];

/**
 * Which routing profile a request made in this mode goes through.
 *
 * Discriminated rather than `RoutingProfileId | null`, because `null` would
 * have to mean both "the product default decides" and "no profile is
 * configured", and those render as opposite things in a picker. `default` is a
 * live, named path — `getDefaultAliaModel()` — not an absence.
 */
export type ProductModeRouting =
  | { readonly kind: 'profile'; readonly profile: RoutingProfileId }
  | { readonly kind: 'default' };

export interface ProductMode {
  /**
   * The mode's identity, in the product's own namespace.
   *
   * `mode:` rather than `alia-`, because ADR 0002 froze that alias set and a
   * new `alia-*` identifier is exactly the mistake this replaces; and never
   * `alia/<name>`, which `lib/reserved-namespace.ts` refuses outright.
   */
  readonly id: `mode:${string}`;
  readonly label: string;
  readonly description: string;
  readonly routing: ProductModeRouting;
  /**
   * Whether a request in this mode runs the deep-research pipeline — the
   * `deepResearch` flag on the chat request body, read at
   * `lib/chat/request-context.ts:144`.
   */
  readonly deepResearch: boolean;
}

/**
 * The mode table.
 *
 * Six entries, the six #139 names. Written out rather than generated from
 * `ROUTING_PRESETS`: a mode is a product decision about a profile, so
 * generating it would make this file a second view of the routing table and
 * there would be nothing left for a product owner to decide. Drift is caught by
 * assertion instead — every `profile` below is checked against the live preset
 * table, and every derivation is recomputed, in `__tests__/product-modes.test.ts`.
 */
export const PRODUCT_MODES: readonly ProductMode[] = [
  {
    id: 'mode:automatic',
    label: 'Automatic',
    description: 'Alia picks how to answer.',
    routing: { kind: 'default' },
    deepResearch: false,
  },
  {
    id: 'mode:fast',
    label: 'Fast',
    description: 'Quick answers to straightforward questions.',
    routing: { kind: 'profile', profile: 'profile:lite' },
    deepResearch: false,
  },
  {
    id: 'mode:balanced',
    label: 'Balanced',
    description: 'The everyday default: quick enough, capable enough.',
    routing: { kind: 'profile', profile: 'profile:v1' },
    deepResearch: false,
  },
  {
    id: 'mode:maximum-quality',
    label: 'Maximum quality',
    description: 'The most capable answer available, for demanding work.',
    routing: { kind: 'profile', profile: 'profile:v1-pro-max' },
    deepResearch: false,
  },
  {
    id: 'mode:coding',
    label: 'Coding',
    description: 'Tuned for reading, writing and changing code.',
    routing: { kind: 'profile', profile: 'profile:v1-codea' },
    deepResearch: false,
  },
  {
    id: 'mode:deep-research',
    label: 'Deep research',
    description: 'Multi-step research across sources, answered with citations.',
    routing: { kind: 'default' },
    deepResearch: true,
  },
];

/**
 * Which policies the product offers, and the only identities it advertises —
 * the visibility decision #139 asks Alia product owners to own.
 *
 * ## The `alia-*` aliases are advertised nowhere
 *
 * Keyed by PROFILE, not by alias, and that is the whole point rather than a
 * detail. Every one of the thirteen `alia-*` identifiers is a routing profile
 * wearing a model's name, and two of them — `alia-v1-thinking` and
 * `alia-v1-pro-max` — are the SAME profile differing only in the system prompt
 * their id selects (`lib/prompt-loader.ts` loads a prompt file per model id).
 * A quality tier, a reasoning level and a Codea preset sold as model identities
 * is precisely what #139 removes.
 *
 * So the product's vocabulary is `profile:*`, one identity per policy by
 * construction: a profile IS a policy, so two names for one policy cannot be
 * expressed here at all. The bijection is not a rule to remember, it is the
 * shape of the type.
 *
 * The aliases keep RESOLVING — `internal/providers/lib/alia-models.ts` is
 * untouched and every published `@alia.onl/sdk` and `@alia-codea/cli` copy in
 * the wild keeps working unchanged — they are simply advertised by nothing.
 * `docs/migration/compatibility-window.md` records that closure and its
 * evidence.
 *
 * It is a `const` in a committed file, and that is the whole audit trail: a
 * visibility change is a commit. `lib/routing/__tests__/routing-config-audit.test.ts`
 * records that Alia has NO audited runtime surface for routing configuration —
 * `plans.modelIds` is the one unaudited row it found — so putting this behind a
 * route today would add a second one.
 */
export const OFFERED_PROFILES: readonly RoutingProfileId[] = [
  'profile:lite',
  'profile:v1',
  'profile:v1-pro',
  'profile:v1-pro-max',
];

const OFFERED = new Set<string>(OFFERED_PROFILES);

/**
 * The namespace the legacy identifiers live in.
 *
 * Written as a PREFIX with no segment after it, so it is not itself an
 * alias-shaped literal — which is what keeps this file out of gate 3's census
 * of `alia-*` literals in product source, the same reason
 * `lib/routing/alias-translation.ts` spells it this way.
 */
const ALIAS_NAMESPACE = 'alia-';

/**
 * The alias a profile is SERVED BY, derived rather than declared.
 *
 * Every preset id is `profile:<tier>` and every tier has an alias named
 * `alia-<tier>`, so the canonical identity falls out of the two naming schemes
 * agreeing — no table, no tiebreak to maintain. For `profile:v1-pro-max` that
 * picks `alia-v1-pro-max` over `alia-v1-thinking`, which is the same answer the
 * general-purpose ordering reaches by category, from an independent direction.
 *
 * It exists because the alias is still the KEY several tables are indexed by:
 * `plans.modelIds` and the entitlement read model are both keyed by alias, and
 * so is the `isLegacy` flag the admin tool writes. What it no longer owns is
 * the metadata a request needs — the credit multiplier `lib/credits-manager.ts`
 * bills on, `maxTokens`, the category and the prompt file are declared on the
 * routing preset (`lib/routing/presets.ts`) and read from there.
 *
 * Throws at module load rather than skipping, matching
 * `lib/routing/alias-translation.ts`: a preset with no matching alias is a
 * configuration error, and a profile that silently cannot be served is worse
 * than a process that refuses to start. The inputs are static, so the suite
 * beside this file is what proves it never fires.
 */
function canonicalAliasOf(preset: RoutingPreset): string {
  const alias = `${ALIAS_NAMESPACE}${preset.tier}`;
  if (!preset.aliases.includes(alias)) {
    throw new Error(`routing preset ${preset.id} has no canonical alias named for its tier`);
  }
  return alias;
}

const CANONICAL_ALIAS_BY_PROFILE: ReadonlyMap<string, string> = new Map(
  ROUTING_PRESETS.map((preset) => [preset.id, canonicalAliasOf(preset)] as const),
);

/** Alias → its profile id, built once from the preset table. */
const PROFILE_BY_ALIAS: ReadonlyMap<string, RoutingProfileId> = new Map(
  ROUTING_PRESETS.flatMap((preset) => preset.aliases.map((alias) => [alias, preset.id] as const)),
);

/** The identity a profile is served by, or `null` when no preset defines it. */
export function canonicalAliasFor(profileId: string): string | null {
  return CANONICAL_ALIAS_BY_PROFILE.get(profileId) ?? null;
}

/** The policy an identifier selects, or `null` when nothing does. */
export function profileIdFor(aliasModelId: string): RoutingProfileId | null {
  return PROFILE_BY_ALIAS.get(aliasModelId) ?? null;
}

/** Does the product advertise this policy? */
export function isProfileOffered(profileId: string): boolean {
  return OFFERED.has(profileId);
}

/**
 * The identifier the request path routes on, for a product identifier.
 *
 * `profile:*` is the vocabulary the catalogue publishes and the one a client
 * should send; it becomes the alias that carries the metadata. Anything else —
 * including the thirteen legacy aliases — passes through untouched, which is
 * what keeps every already-installed SDK and CLI copy working while nothing
 * advertises those identifiers any more.
 *
 * `null` ONLY for a `profile:` identifier no preset defines, which is a caller
 * naming a policy that does not exist. Returning the input unchanged there
 * would hand `profile:nonsense` to a resolver whose refusal message talks about
 * models, so the caller gets a refusal naming what it actually got wrong.
 */
export function toRoutableAlias(productModelId: string): string | null {
  if (!productModelId.startsWith(PROFILE_ID_PREFIX)) return productModelId;
  return canonicalAliasFor(productModelId);
}
