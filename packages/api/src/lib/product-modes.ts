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
 * The `route:*` identifiers are canonical routing profiles, never concrete
 * model references. Five additionally encode a product decision in the
 * identifier itself: a quality tier (`route:instant` versus `route:pro`), a
 * reasoning level (`route:thinking`), or a surface's preset (`route:code`,
 * `route:cowork`). ADR 0002 calls that last case "a reasoning setting wearing
 * a model's name". A mode is where those decisions belong.
 *
 * ## Every binding below is explicit
 *
 * #139 names six modes by way of example. Which routing profile each one
 * selects is a product decision, so the exact profile identity is committed on
 * each row below. No array position, price ordering or implicit default is
 * routing authority. `__tests__/product-modes.test.ts` checks each declared ID
 * against the live routing table and fails closed if one disappears.
 *
 * Auto and Research each have an explicit route. Research also activates its
 * pipeline flag; neither mode inherits an unrelated request default by omission.
 */

import {
  isKaanaRoutingProfileId,
  type KaanaRoutingProfileId,
} from './routing/kaana-profiles.js';
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
export type ProductModeRouting = {
  readonly kind: 'profile';
  readonly profile: RoutingProfileId;
};

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
    id: 'mode:auto',
    label: 'Auto',
    description: 'Alia picks how to answer.',
    routing: { kind: 'profile', profile: 'route:auto' },
    deepResearch: false,
  },
  {
    id: 'mode:instant',
    label: 'Instant',
    description: 'Quick answers to straightforward questions.',
    routing: { kind: 'profile', profile: 'route:instant' },
    deepResearch: false,
  },
  {
    id: 'mode:thinking',
    label: 'Thinking',
    description: 'Takes more time to reason through complex work.',
    routing: { kind: 'profile', profile: 'route:thinking' },
    deepResearch: false,
  },
  {
    id: 'mode:pro',
    label: 'Pro',
    description: 'The most capable answer available, for demanding work.',
    routing: { kind: 'profile', profile: 'route:pro' },
    deepResearch: false,
  },
  {
    id: 'mode:code',
    label: 'Code',
    description: 'Tuned for reading, writing and changing code.',
    routing: { kind: 'profile', profile: 'route:code' },
    deepResearch: false,
  },
  {
    id: 'mode:research',
    label: 'Research',
    description: 'Multi-step research across sources, answered with citations.',
    routing: { kind: 'profile', profile: 'route:research' },
    deepResearch: true,
  },
];

export type ProductModeId = (typeof PRODUCT_MODES)[number]['id'];

const PRODUCT_MODE_BY_ID: ReadonlyMap<string, ProductMode> = new Map(
  PRODUCT_MODES.map((mode) => [mode.id, mode]),
);

/** Exact product-boundary lookup. Mode names are never inferred or aliased. */
export function getProductMode(id: unknown): ProductMode | null {
  return typeof id === 'string' ? (PRODUCT_MODE_BY_ID.get(id) ?? null) : null;
}

/**
 * Which policies the product offers, and the only identities it advertises —
 * the visibility decision #139 asks Alia product owners to own.
 *
 * ## Product modes are public; routes are internal
 *
 * Keyed by canonical `route:*` profile, not by an internal policy id. Two —
 * `route:thinking` and
 * `route:pro` — are the SAME profile differing only in the system prompt
 * their id selects (`lib/prompt-loader.ts` loads a prompt file per model id).
 * A quality tier, a reasoning level and a Codea preset sold as model identities
 * is precisely what #139 removes.
 *
 * The public picker vocabulary is `mode:*`. Both `route:*` routing profiles and
 * `profile:*` policy IDs remain implementation details.
 *
 * It is a `const` in a committed file, and that is the whole audit trail: a
 * visibility change is a commit. `lib/routing/__tests__/routing-config-audit.test.ts`
 * records that Alia has NO audited runtime surface for routing configuration —
 * `plans.modelIds` is the one unaudited row it found — so putting this behind a
 * route today would add a second one.
 */
export const OFFERED_PROFILES: readonly RoutingProfileId[] = [
  'route:auto',
  'route:instant',
  'route:thinking',
  'route:pro',
  'route:research',
  'route:code',
];

const OFFERED = new Set<string>(OFFERED_PROFILES);

/** Internal policy preset → its primary canonical Kaana routing profile. */
const ROUTING_PROFILE_BY_POLICY: ReadonlyMap<string, RoutingProfileId> =
  new Map(
    ROUTING_PRESETS.map((preset) => {
      const profileId = preset.primaryProfileId;
      if (
        !isKaanaRoutingProfileId(profileId) ||
        !preset.profileIds.includes(profileId)
      ) {
        throw new Error(
          `routing preset ${preset.id} has an invalid explicit primary Kaana routing profile`,
        );
      }
      return [preset.id, profileId] as const;
    }),
  );

/** Canonical Kaana routing profile → the local policy preset it selects. */
const ROUTING_POLICY_BY_PROFILE: ReadonlyMap<string, RoutingPreset['id']> =
  new Map(
    ROUTING_PRESETS.flatMap((preset) =>
      preset.profileIds.map((profileId) => [profileId, preset.id] as const),
    ),
  );

/** The canonical routing profile serving an internal policy, or `null`. */
export function routingProfileFor(policyId: string): RoutingProfileId | null {
  return ROUTING_PROFILE_BY_POLICY.get(policyId) ?? null;
}

/** The internal policy selected by a canonical Kaana routing profile, or `null`. */
export function routingPolicyIdFor(
  profileId: string,
): RoutingPreset['id'] | null {
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
export function toRoutingProfile(
  productModelId: string,
): RoutingProfileId | null {
  return isKaanaRoutingProfileId(productModelId) ? productModelId : null;
}
