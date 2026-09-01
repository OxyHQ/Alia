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
 * The thirteen `kaana-*` identifiers are canonical routing profiles, never
 * concrete model references. Five additionally encode a product decision in the
 * identifier itself: a quality tier (`kaana-lite` versus `kaana-v1-pro-max`), a
 * reasoning level (`kaana-v1-thinking`), or a surface's preset (`kaana-v1-codea`,
 * `kaana-v1-cowork`). ADR 0002 calls that last case "a reasoning setting wearing
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
 * `kaana-lite`, `kaana-v1` and `kaana-v1-pro-max` — so ordering them by credit
 * multiplier is total and has no ties: cheapest is Fast, dearest is Maximum
 * quality, and the one left over is Balanced. Their own descriptions agree
 * word for word ("Fast responses for simple tasks", "Balanced performance for
 * everyday tasks", "Best available models for demanding tasks"), which is the
 * cross-check rather than the derivation.
 *
 * Coding is read off the CONSUMERS instead: `packages/alia-codea/package.json`,
 * `packages/alia-codea/src/*` and `packages/alia-codea-cli/src/utils/config.ts`
 * all default to `kaana-v1-codea`, so the coding profile is the one the coding
 * product already selects.
 *
 * ## Two modes pin no profile, and that is the measurement too
 *
 * Automatic and Deep research both carry {@link ProductModeRouting} `default`,
 * because neither changes routing today and saying otherwise would be the
 * invention this file exists to avoid.
 *
 *  - **Automatic** is the mode that expresses no preference. A request that
 *    names no model already routes through `getDefaultRoutingProfile()`
 *    (`lib/chat/request-context.ts:161`), so `default` is not a stub — it is
 *    that path, named. Selecting a profile per request from the prompt is
 *    routing work, and ADR 0001 puts routing behind Kaana.
 *  - **Deep research** is a PIPELINE, not a tier. `handleDeepResearch` runs on
 *    `ctx.routingProfileId` — whatever the request already resolved
 *    (`lib/chat-modes/deep-research-handler.ts:31`) — so binding it to a
 *    quality tier would attach a routing claim to a mode that makes none. It
 *    differs from Automatic in exactly one published field, {@link
 *    ProductMode.deepResearch}, which is the request flag it sets.
 */

import { isKaanaRoutingProfileId, type KaanaRoutingProfileId } from './routing/kaana-profiles.js';
import { ROUTING_PRESETS, type RoutingPreset } from './routing/presets.js';

/** A canonical routing-profile identity owned by Kaana. Never `<publisher>/<model>`. */
export type RoutingProfileId = KaanaRoutingProfileId;

/**
 * Which routing profile a request made in this mode goes through.
 *
 * Discriminated rather than `RoutingProfileId | null`, because `null` would
 * have to mean both "the product default decides" and "no profile is
 * configured", and those render as opposite things in a picker. `default` is a
 * live, named path — `getDefaultRoutingProfile()` — not an absence.
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
    routing: { kind: 'profile', profile: 'kaana-lite' },
    deepResearch: false,
  },
  {
    id: 'mode:balanced',
    label: 'Balanced',
    description: 'The everyday default: quick enough, capable enough.',
    routing: { kind: 'profile', profile: 'kaana-v1' },
    deepResearch: false,
  },
  {
    id: 'mode:maximum-quality',
    label: 'Maximum quality',
    description: 'The most capable answer available, for demanding work.',
    routing: { kind: 'profile', profile: 'kaana-v1-pro-max' },
    deepResearch: false,
  },
  {
    id: 'mode:coding',
    label: 'Coding',
    description: 'Tuned for reading, writing and changing code.',
    routing: { kind: 'profile', profile: 'kaana-v1-codea' },
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
 * ## Kaana profiles are the public routing vocabulary
 *
 * Keyed by canonical `kaana-*` profile, not by an internal policy id. Two —
 * `kaana-v1-thinking` and
 * `kaana-v1-pro-max` — are the SAME profile differing only in the system prompt
 * their id selects (`lib/prompt-loader.ts` loads a prompt file per model id).
 * A quality tier, a reasoning level and a Codea preset sold as model identities
 * is precisely what #139 removes.
 *
 * The product vocabulary is therefore the Kaana profile set itself. Internal
 * `profile:*` policy IDs are implementation details and are never accepted at
 * a request boundary.
 *
 * It is a `const` in a committed file, and that is the whole audit trail: a
 * visibility change is a commit. `lib/routing/__tests__/routing-config-audit.test.ts`
 * records that Alia has NO audited runtime surface for routing configuration —
 * `plans.modelIds` is the one unaudited row it found — so putting this behind a
 * route today would add a second one.
 */
export const OFFERED_PROFILES: readonly RoutingProfileId[] = [
  'kaana-lite',
  'kaana-v1',
  'kaana-v1-pro',
  'kaana-v1-pro-max',
];

const OFFERED = new Set<string>(OFFERED_PROFILES);

/** Internal policy preset → its primary canonical Kaana routing profile. */
const ROUTING_PROFILE_BY_POLICY: ReadonlyMap<string, RoutingProfileId> = new Map(
  ROUTING_PRESETS.map((preset) => {
    const profileId = preset.profileIds[0];
    if (!isKaanaRoutingProfileId(profileId)) {
      throw new Error(`routing preset ${preset.id} has no canonical Kaana routing profile`);
    }
    return [preset.id, profileId] as const;
  }),
);

/** Canonical Kaana routing profile → the local policy preset it selects. */
const ROUTING_POLICY_BY_PROFILE: ReadonlyMap<string, RoutingPreset['id']> = new Map(
  ROUTING_PRESETS.flatMap((preset) => preset.profileIds.map((profileId) => [profileId, preset.id] as const)),
);

/** The canonical routing profile serving an internal policy, or `null`. */
export function routingProfileFor(policyId: string): RoutingProfileId | null {
  return ROUTING_PROFILE_BY_POLICY.get(policyId) ?? null;
}

/** The internal policy selected by a canonical Kaana routing profile, or `null`. */
export function routingPolicyIdFor(profileId: string): RoutingPreset['id'] | null {
  return ROUTING_POLICY_BY_PROFILE.get(profileId) ?? null;
}

/** Does the product advertise this policy? */
export function isProfileOffered(profileId: string): boolean {
  return OFFERED.has(profileId);
}

/**
 * Accept a canonical Kaana routing-profile identity at the product boundary.
 * No compatibility spelling or internal `profile:*` policy id is translated.
 */
export function toRoutingProfile(productModelId: string): RoutingProfileId | null {
  return isKaanaRoutingProfileId(productModelId) ? productModelId : null;
}
