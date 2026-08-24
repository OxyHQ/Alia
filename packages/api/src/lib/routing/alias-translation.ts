/**
 * Translating an `alia-*` identifier into the contract's routing target —
 * epic #139 workstream 18, *"Implement route/model ID translation for
 * compatibility"*.
 *
 * `docs/migration/alias-migration-map.json` publishes what each of the thirteen
 * aliases BECOMES: a routing profile, identified as `profile:<tier>`. That file
 * is a promise to callers. Until this module existed nothing kept it, because
 * nothing translated: `lib/inference/kaana-request.ts` read an alias
 * structurally — no `/`, therefore a routing profile — and sent `alia-v1-pro`
 * on the wire as a profile literally named `alia-v1-pro`, which is not what the
 * map says it becomes and not a profile Relay could be expected to know.
 *
 * ## Why the wire slug drops the `profile:` prefix
 *
 * The contract cannot carry it. `routingProfileSlugSchema` is
 * `^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$` — no colon — so `profile:v1-pro` is not
 * a value `RoutingTarget` admits. That is not an obstacle to work around: the
 * prefix exists in Alia's own id space because that space is FLAT (one `model`
 * string carries both models and profiles, so a profile needs a marker saying it
 * is one), and the contract does not need a marker because it has a
 * discriminated union. `kind: 'routing_profile'` IS the `profile:` prefix,
 * expressed in a type instead of in a string.
 *
 * So the translation is total in both directions and the guard beside this file
 * asserts the round trip: `profile:` + `target.routingProfile` reproduces the
 * `becomes.id` the map publishes, for all thirteen. The same string is what
 * `lib/catalogue.ts` already serves to product clients as `profileId`, so the
 * migration map, the catalogue and the wire agree on one identity.
 *
 * ## Why it reads the preset table and not the JSON
 *
 * `docs/` is not in the runtime image, so a serving process cannot read the map;
 * and a second copy of the map's data compiled into `src/` would be the drift
 * the map exists to prevent. `ROUTING_PRESETS` is already asserted equal to the
 * map's own rule — `becomes.id` is `profile:<tier>`, quoted from the map at
 * `__tests__/routing-policy.test.ts:35` — so deriving from the presets and
 * ASSERTING against the JSON is what makes the published map the authority
 * without making it a runtime dependency.
 *
 * ## What this is not
 *
 * Not a rewrite. An identifier that is not one of the thirteen gets `null`, and
 * the caller refuses it — `resolveRoutingTarget` throws `invalid_request`.
 * Reading an unknown id as "some profile" is how a typo becomes "Oxy chose
 * something for you", which is the substitution ADR 0003 invariant 2 forbids.
 */

import { routingProfileSlugSchema, type RoutingTarget } from '@oxyhq/contracts';

import { ROUTING_PRESETS, type RoutingPreset } from './presets.js';

/** The namespace marker Alia's flat id space needs and the contract's union does not. */
const PROFILE_ID_PREFIX = 'profile:';

/**
 * The namespace every Alia identifier lives in.
 *
 * Written with the trailing hyphen and no segment after it, so it is a PREFIX
 * and not an identifier — which is also what keeps it out of gate 3's census of
 * alias-shaped literals in product source.
 */
const ALIAS_NAMESPACE = 'alia-';

/** One alias, the profile id published for it, and the target it travels as. */
export interface AliasTranslation {
  /** The `alia-*` identifier a caller may still be holding. */
  readonly alias: string;
  /** What `docs/migration/alias-migration-map.json` publishes as its replacement. */
  readonly profileId: `profile:${string}`;
  /** The same profile as the contract expresses it. */
  readonly target: RoutingTarget;
}

/**
 * Throws rather than skipping.
 *
 * A preset whose id cannot be expressed as a contract profile is a
 * configuration error, and the two ways to be lenient about it are both worse
 * than failing: dropping the entry makes an alias silently untranslatable, and
 * emitting the id unparsed puts a value on the wire the contract rejects. The
 * inputs are static, so the suite beside this file is what proves this never
 * fires.
 */
function targetFor(preset: RoutingPreset): RoutingTarget {
  const slug = preset.id.slice(PROFILE_ID_PREFIX.length);
  const parsed = routingProfileSlugSchema.safeParse(slug);
  if (!parsed.success) {
    throw new Error(`routing preset ${preset.id} does not name a contract routing profile`);
  }
  return { kind: 'routing_profile', routingProfile: parsed.data };
}

/**
 * Every alias, in preset order.
 *
 * Thirteen entries from twelve presets: `alia-v1-thinking` and
 * `alia-v1-pro-max` share a tier, so they translate to the same target — two
 * identifiers for one policy, which is the case ADR 0002 describes as a
 * reasoning setting wearing a model's name.
 */
export const ALIAS_TRANSLATIONS: readonly AliasTranslation[] = ROUTING_PRESETS.flatMap((preset) => {
  const target = targetFor(preset);
  return preset.aliases.map((alias) => ({ alias, profileId: preset.id, target }));
});

const BY_ALIAS: ReadonlyMap<string, AliasTranslation> = new Map(
  ALIAS_TRANSLATIONS.map((translation) => [translation.alias, translation] as const),
);

/**
 * The legacy identifiers a routing profile stands for.
 *
 * The reverse of {@link translateAlias}, and it exists because the two
 * vocabularies meet at more than one seam. `@alia.onl/sdk` asks for
 * `profile:v1-voice`; `plans.model_ids` — and therefore
 * `getUserEntitlements().allowedModelIds` — is keyed by `alia-v1-voice`. A gate
 * that compares one against the other refuses EVERY request, for every account
 * and every plan, and reports it as "upgrade your plan": a permission error
 * that no permission can satisfy.
 *
 * Empty for anything that is not a registered profile, which callers must read
 * as "no alias stands for this" rather than as an error — a concrete model
 * reference is not a profile and is nobody's alias.
 */
export function aliasesForProfile(profileId: string): readonly string[] {
  return BY_PROFILE.get(profileId) ?? [];
}

const BY_PROFILE: ReadonlyMap<string, readonly string[]> = (() => {
  const grouped = new Map<string, string[]>();
  for (const { alias, profileId } of ALIAS_TRANSLATIONS) {
    const existing = grouped.get(profileId);
    if (existing) existing.push(alias);
    else grouped.set(profileId, [alias]);
  }
  return grouped;
})();

/**
 * The three answers, kept apart.
 *
 * `unregistered_alias` is the one that would be lost by returning `null` for
 * everything unknown, and it is the one that matters: `alia-flash` is a
 * well-formed routing-profile slug, so a caller that treated "not translated"
 * as "not my business" would hand Relay a profile in ALIA's namespace that
 * nothing has ever defined. Which identifiers exist in that namespace is a
 * question only Alia can answer, so answering it is not optional.
 */
export type AliasTranslationResult =
  | { readonly kind: 'translated'; readonly translation: AliasTranslation }
  | { readonly kind: 'unregistered_alias' }
  | { readonly kind: 'not_an_alias' };

/**
 * What a legacy identifier becomes.
 *
 * No default and no rewrite: see the module header. A caller holding
 * `not_an_alias` is holding an identifier this module has no opinion about —
 * `alia/v1-pro`, `auto`, a concrete reference — and decides for itself.
 */
export function translateAlias(productModelId: string): AliasTranslationResult {
  const translation = BY_ALIAS.get(productModelId);
  if (translation !== undefined) return { kind: 'translated', translation };
  if (productModelId.startsWith(ALIAS_NAMESPACE)) return { kind: 'unregistered_alias' };
  return { kind: 'not_an_alias' };
}
