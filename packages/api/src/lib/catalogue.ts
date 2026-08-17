/**
 * The truthful model catalogue (ADR 0003, epic #139 workstream 5).
 *
 * ADR 0003 invariant 1: *a routing profile is never serialized as
 * `object: "model"`. A catalogue response distinguishes a model from a routing
 * profile in its type, not in a naming convention a client is expected to
 * decode.* `GET /v1/models` violates that for all thirteen aliases and cannot
 * be fixed in place — see `routes/catalogue.ts` for why the truthful shape is a
 * separate surface rather than a change to that one.
 *
 * This module is the derivation. It answers three questions per entry, each
 * from data rather than from a declaration:
 *
 *  1. **Is it a model or a routing profile?** By fan-out, which is ADR 0003's
 *     own discriminator and the one `docs/migration/alias-migration-map.json`
 *     records: an identifier resolving to ONE model is a reference to that
 *     model, one selecting among several is a policy over several. Deriving it
 *     rather than reading a stored label is what stops the catalogue and the
 *     routing table disagreeing — change the routing and the type changes with
 *     it, in the same deploy.
 *
 *  2. **What can it actually do?** From the capabilities carried by the
 *     candidate mappings the fallback engine walks, NOT from the alias's own
 *     `supportsTools` / `supportsVision` / `maxTokens` fields. Those three are
 *     read by nothing in the request path — `lib/chat/model-config.ts:82` takes
 *     `max_tokens` from the request body and every provider adapter defaults to
 *     `config?.maxTokens ?? 8192`; no code branches on `supportsVision` or
 *     `supportsTools` at all. They are declarations nothing enforces, and they
 *     are wrong in BOTH directions today: `alia-lite` declares `vision: false`
 *     while four of its sixteen candidates support vision (a picker greying out
 *     a working feature), and `alia-v1-audio` declares `supportsTools: true`
 *     while none of its three candidates support tools (a picker offering one
 *     that never works).
 *
 *  3. **Who may use it?** From the plan catalogue, which is the entitlement
 *     mechanism this repository already has (`lib/plan-access.ts`, ADR 0005's
 *     low-latency read model) — not from the credit-multiplier heuristic at
 *     `routes/v1/models.ts:13`, which infers a plan name from a price and
 *     happens to agree with the seeded plans without being connected to them.
 *
 * ## Unknown is a value, not a default
 *
 * A capability the repository has no data for is reported `unknown`, never
 * `never`. They are different claims: a picker that greys out a working feature
 * is a bug, and reporting `never` for something merely unmeasured produces
 * exactly that. `reasoning` and `structured_output` are `unknown` for every
 * entry today because no capability record in this repository carries either —
 * `ModelCapabilities` (`internal/providers/lib/alia-models.ts:14`) has no field
 * for them and neither does any inline mapping. Inventing a value for them is
 * the specific thing this module refuses to do.
 *
 * ## Everything here reads through `gateway-client`
 *
 * ADR 0001's sanctioned seam, and the reason no import in this file crosses
 * into `src/internal/providers/` — see gate 1 in `__tests__/architectureGates`.
 * When routing moves to Relay this module keeps working against the same
 * functions.
 */

import { getAvailableModels, getTierMappings, getPlans, type PlanData } from './gateway-client.js';
import { getUserEntitlements } from './plan-access.js';
import { ALIAS_DEPRECATION, ALIAS_SUNSET, DEPRECATED_ALIASES } from '../middleware/alias-deprecation.js';
import { PLAN_PRODUCTS, type PlanProduct } from '../domain/plan.js';
import { isAliasVisible } from './product-modes.js';
import type { FallbackPolicy } from './routing/policy.js';
import { log } from './logger.js';

/**
 * The fallback policy the capability figures below describe.
 *
 * Capability availability is computed over EVERY candidate mapping in the
 * profile's ranked list, and that set is exactly what
 * `internal/providers/lib/fallback-engine.ts` `candidatesUnderPolicy` returns
 * for `cross-model` — the branch that removes no candidate. Under
 * `no-fallback` the engine walks `[sortedMappings[0]]` and under
 * `same-model-only` only the deployments of the top-ranked model, so the same
 * entry has genuinely different capability answers under those policies:
 * `alia-lite` reports `vision: 'sometimes'` here and would be deterministic
 * under `no-fallback`.
 *
 * Typed as {@link FallbackPolicy} rather than a string of its own, because two
 * vocabularies for one concept is what ADR 0003 exists to end. It is a LITERAL
 * rather than a read of `DEFAULT_FALLBACK_POLICY`: reading the constant would
 * make this label follow a default flip while the computation stayed put, which
 * turns an accurate label into a lie in one commit. The suite asserts both that
 * this is `cross-model` AND that it still equals the default, so a flip cannot
 * be absorbed by editing this line — the derivation has to change with it.
 *
 * Per-policy figures would need `candidatesUnderPolicy` itself, which is not
 * exported and lives inside the provider tree. Reusing it means lifting it into
 * `lib/routing/` first; copying it here would be the second implementation this
 * comment exists to prevent.
 */
export const CAPABILITY_POLICY: FallbackPolicy = 'cross-model';

/**
 * How available a capability is across everything an entry can route to.
 *
 * Four states rather than a boolean because a routing profile answers from a
 * DIFFERENT model each time, so "does it support vision" genuinely has three
 * true answers plus "we do not know". `sometimes` is the common case and the
 * one a boolean has to lie about in one direction or the other.
 *
 * For a concrete model reference — one candidate — `sometimes` cannot occur,
 * so the same vocabulary is total for both entry types and a client switches
 * on it once.
 */
export type CapabilityAvailability = 'always' | 'sometimes' | 'never' | 'unknown';

/**
 * A token bound across the candidate set.
 *
 * `guaranteed` is the minimum: the value a caller can rely on whichever
 * candidate answers. `upTo` is the maximum: what the best candidate offers.
 * They are equal for a concrete model reference. Reporting only the maximum
 * would promise a context window most candidates cannot honour; reporting only
 * the minimum would hide capacity a caller can often use.
 */
export interface TokenBound {
  readonly guaranteed: number;
  readonly upTo: number;
}

export interface CatalogueCapabilities {
  readonly tools: CapabilityAvailability;
  readonly vision: CapabilityAvailability;
  readonly audio: CapabilityAvailability;
  readonly reasoning: CapabilityAvailability;
  readonly structuredOutput: CapabilityAvailability;
  readonly contextWindow: TokenBound | null;
  readonly maxOutput: TokenBound | null;
  /**
   * The routing policy these figures describe. See {@link CAPABILITY_POLICY} —
   * a caller who sets a different `fallback_policy` on a request is asking a
   * question this block does not answer.
   */
  readonly underPolicy: FallbackPolicy;
}

/**
 * What a caller is entitled to, or an explicit admission that we could not find
 * out.
 *
 * Discriminated rather than nullable fields: `requiredPlan: null` already means
 * "no plan required", so a plan lookup that failed cannot borrow it without
 * claiming an entry is free. `state: 'unknown'` is the only honest answer when
 * the plan catalogue is unreachable, and a client switching on `state` cannot
 * mistake one for the other.
 *
 * `entitled` is `null` for an unauthenticated request — nobody's entitlement is
 * being described, which is not the same as "not entitled".
 */
export type CatalogueEntitlement =
  | { readonly state: 'unknown' }
  | {
      readonly state: 'known';
      /**
       * How the entry is reached: included in a free plan, gated behind a paid
       * one, or granted by no active plan at all.
       *
       * Separate from `requiredPlan` because `null` there would otherwise have
       * to mean both "free" and "no plan sells this", and those render as
       * opposite things. `/v1/models` conflates them today, which is only
       * invisible because every alias happens to be on a plan.
       */
      readonly access: 'free' | 'plan' | 'none';
      /** Name of the cheapest plan granting this entry. Non-null exactly when `access` is `plan`. */
      readonly requiredPlan: string | null;
      /** Every plan id granting it, so a client can explain the choice rather than just the price. */
      readonly grantedBy: readonly string[];
      /** Which Alia products' plans grant it (`domain/plan.ts` PLAN_PRODUCTS). */
      readonly products: readonly PlanProduct[];
      readonly entitled: boolean | null;
    };

interface CatalogueEntryCommon {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly emoji: string | null;
  /**
   * Product policy: whether the picker surfaces this entry. Read from
   * `product-modes.ts` `VISIBLE_PROFILES`, which is the product's own
   * configuration — never from the provider mapping table, where it used to sit
   * as a `chatVisible` field on five alias definitions.
   */
  readonly chatVisible: boolean;
  readonly capabilities: CatalogueCapabilities;
  readonly availability: { readonly status: 'available' | 'unavailable'; readonly legacy: boolean };
  readonly entitlement: CatalogueEntitlement;
  readonly pricing: { readonly creditMultiplier: number };
  /** Present while the identifier is inside the compatibility window (all thirteen aliases are). */
  readonly deprecation: { readonly deprecatedAt: string; readonly sunsetAt: string | null } | null;
}

/**
 * A product-owned policy that selects among models on the product's behalf.
 * Configuration, not an artifact; it has no weights and no publisher.
 */
export interface RoutingProfileEntry extends CatalogueEntryCommon {
  readonly kind: 'routing_profile';
  /**
   * The identifier this profile takes under ADR 0003, in the product's own
   * namespace and never in `<publisher>/<model>` form. Derived from the tier
   * because the tier IS the policy — the ranked candidate list the fallback
   * engine walks — which is the same derivation
   * `docs/migration/alias-migration-map.json` publishes as `becomes.id`.
   *
   * Two entries may share one: `alia-v1-thinking` and `alia-v1-pro-max` carry
   * the same tier, so they are one policy under two identifiers. Showing that
   * plainly is the point.
   */
  readonly profileId: string;
  /** Distinct models the policy ranks over. Always at least two, by construction. */
  readonly selectsAmong: number;
}

/**
 * A reference to one named body of work published by an organization.
 *
 * `publisher` and `model` are the two halves of ADR 0003's `<publisher>/<model>`
 * identity, and they are deliberately NOT the provider that operates the
 * deployment serving it — ADR 0003: *the provider is a property of the
 * deployment, not of the model.* This entry therefore carries no provider,
 * deployment or region field at all; a caller addresses a model, and which
 * deployment answers is Relay's concern (invariant 4).
 *
 * Both are `null` today and no entry of this kind is served, for two reasons
 * that point the same way. Every one of the thirteen aliases fans out to at
 * least two models, so none is a concrete reference; and publisher attribution
 * does not exist in this repository — the routing table stores a bare provider
 * model id with no publisher segment, and the migration map records that as a
 * finding rather than an omission, with attribution belonging to Relay's
 * catalogue. Filling these from `ModelMapping.modelId` would be wrong twice
 * over: a provider model id is a deployment address rather than a model
 * identity, and publishing one would breach the model-abstraction rule that
 * `packages/api/src/__tests__/` asserts against every catalogue response.
 */
export interface ModelEntry extends CatalogueEntryCommon {
  readonly kind: 'model';
  readonly publisher: string | null;
  readonly model: string | null;
}

export type CatalogueEntry = RoutingProfileEntry | ModelEntry;

/** One routable choice: what the fallback engine may pick, with what it can do. */
export interface Candidate {
  readonly modelId: string;
  readonly capabilities: Record<string, unknown>;
}

/** The alias-shaped facts an entry is built from, independent of where they came from. */
export interface CatalogueSource {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tier: string;
  readonly emoji?: string;
  readonly creditMultiplier: number;
  readonly isAvailable: boolean;
  readonly isLegacy: boolean;
}

const DEPRECATED = new Set(DEPRECATED_ALIASES);

function booleanCapability(candidates: readonly Candidate[], key: string): CapabilityAvailability {
  if (candidates.length === 0) return 'unknown';
  let seen = 0;
  let supporting = 0;
  for (const candidate of candidates) {
    const value = candidate.capabilities[key];
    if (typeof value !== 'boolean') continue;
    seen += 1;
    if (value) supporting += 1;
  }
  // A capability no candidate record mentions is unmeasured, not absent.
  if (seen === 0) return 'unknown';
  // A capability only SOME records mention is also unmeasured: the candidates
  // that omit it might support it. Answering from the subset that happens to
  // carry the field is how a partial record turns into a confident wrong claim.
  if (seen !== candidates.length) return 'unknown';
  if (supporting === 0) return 'never';
  return supporting === candidates.length ? 'always' : 'sometimes';
}

function tokenBound(candidates: readonly Candidate[], key: string): TokenBound | null {
  const values: number[] = [];
  for (const candidate of candidates) {
    const value = candidate.capabilities[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) values.push(value);
  }
  if (values.length === 0 || values.length !== candidates.length) return null;
  return { guaranteed: Math.min(...values), upTo: Math.max(...values) };
}

/**
 * Capability availability across a candidate set.
 *
 * Computed over every MAPPING rather than over distinct model ids, because
 * every mapping is a route the fallback engine may take — two providers serving
 * one model are two chances to answer, and if their recorded capabilities ever
 * disagree the weaker one is a real outcome a caller can get.
 *
 * "May take" is policy-dependent, and the whole list is the set only under
 * {@link CAPABILITY_POLICY}. The result records which policy it describes rather
 * than leaving it implied.
 *
 * `reasoning` and `structuredOutput` are `unknown` unconditionally: no
 * capability record in this repository has a field for either, so
 * {@link booleanCapability} would answer `unknown` for them anyway. Naming them
 * here rather than relying on that is deliberate — if a field with one of those
 * names ever appears, this is where the decision to trust it gets made, rather
 * than the catalogue silently starting to publish it.
 */
export function deriveCapabilities(candidates: readonly Candidate[]): CatalogueCapabilities {
  return {
    tools: booleanCapability(candidates, 'tools'),
    vision: booleanCapability(candidates, 'vision'),
    audio: booleanCapability(candidates, 'audio'),
    reasoning: 'unknown',
    structuredOutput: 'unknown',
    contextWindow: tokenBound(candidates, 'maxContextTokens'),
    maxOutput: tokenBound(candidates, 'maxOutputTokens'),
    underPolicy: CAPABILITY_POLICY,
  };
}

/**
 * Build one catalogue entry.
 *
 * Pure, and the only place the model/routing-profile split is decided. Its
 * discriminant is `candidates`, so a fixture with one candidate exercises the
 * model branch and the invariant can be measured in both directions rather than
 * only in the direction today's data happens to take.
 */
export function buildEntry(
  source: CatalogueSource,
  candidates: readonly Candidate[],
  entitlement: CatalogueEntitlement,
): CatalogueEntry {
  const distinctModels = new Set(candidates.map((c) => c.modelId)).size;
  const common: CatalogueEntryCommon = {
    id: source.id,
    displayName: source.name,
    description: source.description,
    category: source.category,
    emoji: source.emoji ?? null,
    chatVisible: isAliasVisible(source.id),
    capabilities: deriveCapabilities(candidates),
    availability: { status: source.isAvailable ? 'available' : 'unavailable', legacy: source.isLegacy },
    entitlement,
    pricing: { creditMultiplier: source.creditMultiplier },
    deprecation: DEPRECATED.has(source.id)
      ? { deprecatedAt: ALIAS_DEPRECATION.toISOString(), sunsetAt: ALIAS_SUNSET?.toISOString() ?? null }
      : null,
  };

  // ADR 0003's discriminator, applied rather than looked up. One model means a
  // reference to that model; several means a policy over several. Zero
  // candidates is not a reference to anything, so it is a policy that currently
  // selects among nothing — which is what an emptied tier honestly is.
  if (distinctModels === 1) {
    return { ...common, kind: 'model', publisher: null, model: null };
  }
  return {
    ...common,
    kind: 'routing_profile',
    profileId: `profile:${source.tier}`,
    selectsAmong: distinctModels,
  };
}

/** Plan facts the entitlement resolver needs, so the resolver can be driven by fixtures. */
export interface PlanGrant {
  readonly planId: string;
  readonly name: string;
  readonly product: PlanProduct;
  readonly monthlyPrice: number;
  readonly isFree: boolean;
  readonly modelIds: readonly string[];
}

function isPlanProduct(value: string): value is PlanProduct {
  return (PLAN_PRODUCTS as readonly string[]).includes(value);
}

/**
 * What the plan catalogue says about one identifier.
 *
 * "Cheapest" is by monthly price, tie-broken by plan id so the answer is
 * deterministic across two plans at the same price. A free plan granting the
 * entry yields `requiredPlan: null`, which is the same thing `/v1/models`
 * publishes today for a free entry — the value is unchanged, only its
 * derivation stops being a guess about the credit multiplier.
 */
export function resolveEntitlement(
  modelId: string,
  plans: readonly PlanGrant[],
  allowedModelIds: readonly string[] | null,
): CatalogueEntitlement {
  const granting = plans.filter((p) => p.modelIds.includes(modelId));
  const cheapest = [...granting].sort(
    (a, b) => a.monthlyPrice - b.monthlyPrice || a.planId.localeCompare(b.planId),
  )[0];
  const access = cheapest === undefined ? 'none' : cheapest.isFree ? 'free' : 'plan';
  return {
    state: 'known',
    access,
    requiredPlan: access === 'plan' && cheapest !== undefined ? cheapest.name : null,
    grantedBy: granting.map((p) => p.planId).sort(),
    products: [...new Set(granting.map((p) => p.product))].sort(),
    entitled: allowedModelIds === null ? null : allowedModelIds.includes(modelId),
  };
}

function toPlanGrant(plan: PlanData): PlanGrant | null {
  if (!isPlanProduct(plan.product)) return null;
  return {
    planId: plan.planId,
    name: plan.name,
    product: plan.product,
    monthlyPrice: plan.monthlyPrice,
    isFree: plan.isFree,
    modelIds: plan.modelIds ?? [],
  };
}

/**
 * The active plan catalogue, or `null` when it cannot be read.
 *
 * `null` rather than an empty array: an empty array is a legitimate answer
 * ("no plan grants anything") and would make every entry look free, which is
 * the permissive direction. The caller turns `null` into `state: 'unknown'` on
 * every entry, and refuses any FILTER that would need the data — an unevaluable
 * filter answering with an unfiltered list is a silent wrong answer.
 */
export async function loadPlanGrants(): Promise<PlanGrant[] | null> {
  try {
    const plans = await getPlans({ isActive: true });
    const grants: PlanGrant[] = [];
    for (const plan of plans) {
      const grant = toPlanGrant(plan);
      if (grant !== null) grants.push(grant);
    }
    return grants;
  } catch (err: unknown) {
    log.models.warn({ err }, 'Plan catalogue unavailable; entitlement reported as unknown');
    return null;
  }
}

/**
 * The entitlements of the authenticated caller, or `null` when there is none.
 *
 * A failure to read them is also `null`: "we do not know whether you may use
 * this" is true in both cases, and the alternative — treating a lookup failure
 * as "not entitled" — hides working entries from a paying customer.
 */
export async function loadAllowedModelIds(userId: string | null): Promise<string[] | null> {
  if (userId === null) return null;
  try {
    return (await getUserEntitlements(userId)).allowedModelIds;
  } catch (err: unknown) {
    log.models.warn({ err }, 'Entitlements unavailable; entitled reported as unknown');
    return null;
  }
}

export interface CatalogueOptions {
  /** Authenticated caller, or `null`. Decides only the `entitled` field. */
  readonly userId: string | null;
  /** Restrict to entries granted by an active plan of this product. */
  readonly product?: PlanProduct;
  /** Restrict to entries the authenticated caller may use. Requires `userId`. */
  readonly entitledOnly?: boolean;
}

/**
 * Either a catalogue, or the name of the input a requested filter needed and
 * did not get.
 *
 * A filter that cannot be evaluated must not silently serve an unfiltered list:
 * `?product=codea` answering with all thirteen entries is a wrong answer that
 * looks exactly like a right one. Annotation degrades to `unknown`; FILTERING
 * refuses. That is the whole distinction this union exists to carry.
 */
export type CatalogueResult =
  | {
      readonly ok: true;
      readonly entries: readonly CatalogueEntry[];
      /** False when the plan catalogue could not be read, so every entitlement is `unknown`. */
      readonly entitlementsKnown: boolean;
    }
  | { readonly ok: false; readonly unavailable: 'plans' | 'entitlements' };

/**
 * The whole catalogue, derived from the live routing table.
 *
 * Ordering is by credit multiplier then id: stable across requests, and it does
 * not encode a recommendation the way "default first" does. The default
 * selection is a separate product decision and is not expressed by position.
 */
export async function buildCatalogue(options: CatalogueOptions): Promise<CatalogueResult> {
  const [sources, tierMappings, plans, allowedModelIds] = await Promise.all([
    getAvailableModels(),
    getTierMappings(),
    loadPlanGrants(),
    loadAllowedModelIds(options.userId),
  ]);

  if (options.product !== undefined && plans === null) return { ok: false, unavailable: 'plans' };
  if (options.entitledOnly === true && allowedModelIds === null) return { ok: false, unavailable: 'entitlements' };

  const entries: CatalogueEntry[] = [];
  for (const source of sources) {
    const candidates: Candidate[] = (tierMappings[source.tier] ?? []).map((m) => ({
      modelId: m.modelId,
      capabilities: m.capabilities,
    }));
    const entitlement =
      plans === null ? { state: 'unknown' as const } : resolveEntitlement(source.id, plans, allowedModelIds);

    if (entitlement.state === 'known') {
      if (options.product !== undefined && !entitlement.products.includes(options.product)) continue;
      if (options.entitledOnly === true && entitlement.entitled !== true) continue;
    }

    entries.push(buildEntry(source, candidates, entitlement));
  }

  entries.sort((a, b) => a.pricing.creditMultiplier - b.pricing.creditMultiplier || a.id.localeCompare(b.id));
  return { ok: true, entries, entitlementsKnown: plans !== null };
}
