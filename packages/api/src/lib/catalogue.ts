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
 * When routing moves to Kaana this module keeps working against the same
 * functions.
 */

import {
  getAllProviderHealth,
  getAvailableModels,
  providersWithUsableCredentials,
  getTierMappings,
  getPlans,
  type ModelMapping,
  type PlanData,
} from './gateway-client.js';
import { classifyModels } from './routing/model-selection.js';
import { getUserEntitlements } from './plan-access.js';
import { PLAN_PRODUCTS, type PlanProduct } from '../domain/plan.js';
import { canonicalAliasFor, isProfileOffered } from './product-modes.js';
import { ROUTING_PRESETS } from './routing/presets.js';
import {
  admitEntry,
  type AvailabilityScope,
  type CallerAudience,
  type EntryScopeVerdict,
} from './availability-scope.js';
import { requiredAttributions, type RequiredAttribution } from './model-attribution.js';
import { surfaceCanOffer, type Surface } from './surface-capability.js';
import type { FallbackPolicy } from './routing/policy.js';
import {
  EFFORT_LEVELS,
  reasoningLevelsFor,
  type EffortLevel,
} from './reasoning-effort.js';
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
  /**
   * The effort levels EVERY candidate route can honour, cheapest first.
   *
   * An intersection, not a union, and that is the whole guarantee: a level
   * listed here is one the caller will actually have sent whichever candidate
   * answers. A union would list levels that a fallback silently drops, which is
   * an interface promising a reasoning budget that is not always transmitted —
   * the exact defect `lib/reasoning-effort.ts` exists to end.
   *
   * Empty is the common answer and is not a failure: a routing profile fanning
   * out over seventeen deployments offers a level only if all seventeen can
   * send it.
   */
  readonly reasoningLevels: readonly EffortLevel[];
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
   * `product-modes.ts` `OFFERED_PROFILES`, which is the product's own
   * configuration — never from the provider mapping table, where it used to sit
   * as a `chatVisible` field on five alias definitions.
   */
  readonly chatVisible: boolean;
  readonly capabilities: CatalogueCapabilities;
  readonly availability: {
    readonly status: 'available' | 'unavailable';
    readonly legacy: boolean;
    /**
     * Which of the entry's routes the caller's own credential admits
     * (#139 workstream 17). `unscoped` on every entry today, because no route
     * declares a scope — see `lib/availability-scope.ts`.
     */
    readonly scope: EntryScopeVerdict;
  };
  /**
   * Attribution an open-weight licence requires be displayed
   * (#139 workstream 17). The ONE field on this entry permitted to name a model
   * identity, and permitted only because a licence requires the naming —
   * `lib/model-attribution.ts` for why that condition is what keeps the
   * permission narrow. Empty on every entry today, because no route carries a
   * licence record.
   */
  readonly attribution: readonly RequiredAttribution[];
  /**
   * Whose models this entry can answer from.
   *
   * A routing profile fans out across organisations — `profile:lite` reaches
   * Google's, Meta's, DeepSeek's, OpenAI's, xAI's, Mistral's and Cohere's work
   * — so "who is answering me" has a set as its honest answer, not a name. A
   * concrete model reference has a set of one.
   *
   * This is NOT `attribution`, which is what an open-weight licence REQUIRES be
   * displayed and is empty unless a licence record says so. Provenance is
   * published because a person asked, and it names the publisher only, never
   * the operator serving the deployment.
   */
  readonly provenance: CatalogueProvenance;
  readonly entitlement: CatalogueEntitlement;
  readonly pricing: { readonly creditMultiplier: number };
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
 * deployment answers is Kaana's concern (invariant 4).
 *
 * Both were `null` on every entry until the routing table learned who published
 * each model and what they called it, and neither is filled from
 * `ModelMapping.modelId`: a deployment address is not a model identity, and
 * publishing one would breach the model-abstraction rule that
 * `packages/api/src/__tests__/architectureGates.test.ts` asserts against every
 * catalogue response. They come from the AUTHORED `publisher` and `model`
 * columns, through {@link Candidate}, so an entry cannot name an identity its
 * own routes do not carry.
 *
 * `null` remains reachable and remains meaningful: a route that arrives without
 * either half — which is what a Kaana catalogue not yet carrying them looks
 * like — yields an entry that says so rather than one that guesses.
 */
export interface ModelEntry extends CatalogueEntryCommon {
  readonly kind: 'model';
  readonly publisher: string | null;
  readonly model: string | null;
}

export type CatalogueEntry = RoutingProfileEntry | ModelEntry;

/**
 * One routable choice: what the fallback engine may pick, with what it can do.
 *
 * The last two fields are Kaana's to supply and are `null` on every candidate
 * this repository builds — `lib/gateway-client.ts` `ModelMapping` declares them
 * optional and nothing populates either. They are declared rather than deferred
 * so the consumption below is real code with real tests instead of a plan, and
 * so the day Kaana carries them nothing here has to change.
 */
export interface Candidate {
  readonly modelId: string;
  /**
   * Whose endpoint this route goes to.
   *
   * Carried because a reasoning option is only real on a FIRST-PARTY client:
   * `lib/chat-core.ts` builds one for `google`, `openai` and `anthropic` and
   * reaches everybody else through `createOpenAI` with a foreign `baseURL`. So
   * "can this route think harder" is a question about the operator as well as
   * the model, and a candidate that knew only the model would answer it wrong
   * for every DigitalOcean-served Claude.
   */
  readonly provider: string;
  /** Who released this model. `null` is unknown, which is not "none". */
  readonly publisher: string | null;
  /**
   * The publisher's own name for it, which is the other half of the identity
   * and is NOT {@link modelId} — that is what the operator calls the
   * deployment. `null` is unknown.
   */
  readonly model: string | null;
  readonly capabilities: Record<string, unknown>;
  /**
   * Whether a request could actually be served on this route right now.
   *
   * Two conditions, and the first is the one whose absence made every entry in
   * this catalogue claim to be available: the route's PROVIDER must hold a
   * usable credential, and the route's circuit breaker must not be open.
   * `getBestKeyForModel` returns `null` for a provider with no key, so a route
   * without one is not a slow route or a degraded route — it is a route the
   * fallback engine walks past every time.
   *
   * Not nullable, unlike its neighbours. A credential either exists or it does
   * not; there is no third state to represent, and an `unknown` here would be
   * the permissive reading that produced the bug.
   */
  readonly servable: boolean;
  /** Who this route may be served to. `null` is unclassified, which is not a scope. */
  readonly availabilityScope: AvailabilityScope | null;
  /** What this route's licence requires be displayed, whole or not at all. */
  readonly attribution: RequiredAttribution | null;
}

/**
 * Whose work an entry can answer from, and how much of that is known.
 *
 * Two fields rather than one list, for the reason the `filters` report exists:
 * a list built from half a table looks exactly like a complete list of half as
 * many publishers. `unattributedRoutes` is what tells them apart.
 *
 * Today the local routing table attributes every route, so the count is zero
 * on every entry. It stops being zero the moment a Kaana catalogue arrives
 * without the field, and a client can then say "these and possibly others"
 * instead of asserting a set it cannot stand behind.
 */
export interface CatalogueProvenance {
  /** Distinct publishers across the entry's candidates, sorted. Never operators. */
  readonly publishers: readonly string[];
  /** Candidates that arrived with no publisher. Not a failure; an unknown. */
  readonly unattributedRoutes: number;
}

/**
 * Sorted, deduplicated, and sorted DELIBERATELY rather than in routing order.
 *
 * Candidate order is the fallback ranking, which is an operational fact about
 * which deployment is tried first. Publishing provenance in that order would
 * leak the ranking through the back door and invite a reader to treat position
 * as preference — the same mistake `GET /catalogue` refuses to make when it
 * says its own price ordering is not a recommendation.
 */
export function deriveProvenance(candidates: readonly Candidate[]): CatalogueProvenance {
  const publishers = new Set<string>();
  let unattributedRoutes = 0;
  for (const candidate of candidates) {
    if (candidate.publisher === null || candidate.publisher === '') {
      unattributedRoutes += 1;
      continue;
    }
    publishers.add(candidate.publisher);
  }
  return { publishers: [...publishers].sort(), unattributedRoutes };
}

/** The alias-shaped facts an entry is built from, independent of where they came from. */
export interface CatalogueSource {
  readonly id: string;
  /**
   * The profile whose visibility decides this entry's.
   *
   * Its own id for a routing profile. For a MODEL it is the profile the model
   * is served under (`lib/routing/model-selection.ts`), because a model is
   * offered exactly when the profile carrying its price, plan and prompt is —
   * offering a model through a profile the chat product does not sell would be
   * offering something with no price behind it.
   *
   * A separate field rather than `id` reused, so the two cannot silently be the
   * same thing: reading visibility off `id` is what made every model entry
   * invisible the first time this was written.
   */
  readonly offeredProfileId: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tier: string;
  readonly emoji?: string;
  readonly creditMultiplier: number;
  /**
   * There is deliberately NO `isAvailable` here.
   *
   * It used to be one, read off the alias, and it is what made this catalogue
   * tell a person that thirty models were available when the deployment held no
   * provider credential at all — `getAvailableModels` answers from circuit
   * breakers alone, and a breaker nothing has ever called is closed. So the
   * question moved to where the answer is: availability is derived from the
   * CANDIDATES, exactly as capabilities and provenance are, and a source that
   * cannot state it cannot get it wrong.
   */
  readonly isLegacy: boolean;
}

/**
 * The levels EVERY candidate can carry.
 *
 * An empty candidate set yields an empty list rather than "all levels": an
 * intersection over nothing is vacuously everything, which would offer four
 * levels for an entry with no routes at all.
 */
function intersectReasoningLevels(candidates: readonly Candidate[]): readonly EffortLevel[] {
  if (candidates.length === 0) return [];
  return EFFORT_LEVELS.filter((level) =>
    candidates.every((candidate) =>
      candidate.publisher !== null &&
      candidate.model !== null &&
      reasoningLevelsFor(candidate.provider, candidate.publisher, candidate.model).includes(level),
    ),
  );
}

function reasoningAvailability(candidates: readonly Candidate[]): CapabilityAvailability {
  if (candidates.length === 0) return 'unknown';
  const supporting = candidates.filter(
    (candidate) =>
      candidate.publisher !== null &&
      candidate.model !== null &&
      reasoningLevelsFor(candidate.provider, candidate.publisher, candidate.model).length > 0,
  ).length;
  if (supporting === 0) return 'never';
  return supporting === candidates.length ? 'always' : 'sometimes';
}

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
 * `reasoning` stopped being `unknown` when a field with that meaning appeared:
 * `lib/reasoning-effort.ts` is authored per `publisher/model`
 * and answers, for one route, which effort levels it can carry. This is the
 * place the note here always said the decision to trust such a field would be
 * made, and it is made by INTERSECTION — see {@link
 * CatalogueCapabilities.reasoningLevels}.
 *
 * `structuredOutput` stays `unknown`: still no record anywhere carries it, so
 * {@link booleanCapability} would answer `unknown` for it anyway, and naming it
 * here keeps the same decision point open for the day one does.
 */
export function deriveCapabilities(candidates: readonly Candidate[]): CatalogueCapabilities {
  const reasoningLevels = intersectReasoningLevels(candidates);
  return {
    tools: booleanCapability(candidates, 'tools'),
    vision: booleanCapability(candidates, 'vision'),
    audio: booleanCapability(candidates, 'audio'),
    /**
     * `always` only when every candidate offers at least one level, `never`
     * when none does, `sometimes` in between — the same three-way reading
     * `booleanCapability` gives, over a set rather than a boolean. It answers
     * "can this entry reason at all", while `reasoningLevels` answers "which
     * levels may I offer", and they are different questions: an entry can be
     * `sometimes` with an empty level set, which is precisely the case where a
     * control must not appear.
     */
    reasoning: reasoningAvailability(candidates),
    reasoningLevels,
    structuredOutput: 'unknown',
    contextWindow: tokenBound(candidates, 'maxContextTokens'),
    maxOutput: tokenBound(candidates, 'maxOutputTokens'),
    underPolicy: CAPABILITY_POLICY,
  };
}

/**
 * What makes two candidates the SAME model.
 *
 * The identity, `<publisher>/<model>`, and never the deployment id. This used
 * to count `modelId`, and it was wrong in exactly the way ADR 0003 invariant 4
 * describes: Meta's Llama 3.3 70B reaches users under six ids, so a tier
 * serving that one model six times reported "selects among 6 models" and a tier
 * serving nothing else would have been classified a routing profile — a policy
 * over one model, which is a contradiction the discriminator is supposed to
 * make impossible. `fallback-engine.ts` fixed the same comparison for
 * `same-model-only`; this is the catalogue's half of it.
 *
 * A route missing either half falls back to its deployment id, which
 * UNDER-collapses: two unattributed routes to one model count as two. That is
 * the safe direction — over-collapsing would assert that two models are one.
 */
function candidateIdentityKey(candidate: Candidate): string {
  if (candidate.publisher === null || candidate.model === null) return `deployment:${candidate.modelId}`;
  return `${candidate.publisher}/${candidate.model}`;
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
  audience: CallerAudience,
): CatalogueEntry {
  const distinctModels = new Set(candidates.map(candidateIdentityKey)).size;
  const common: CatalogueEntryCommon = {
    id: source.id,
    displayName: source.name,
    description: source.description,
    category: source.category,
    emoji: source.emoji ?? null,
    chatVisible: isProfileOffered(source.offeredProfileId),
    capabilities: deriveCapabilities(candidates),
    availability: {
      // Derived, not declared. One servable route is enough — that is what the
      // fallback engine needs to answer — and zero candidates is honestly
      // unavailable rather than inheriting whatever the alias claimed.
      status: candidates.some((candidate) => candidate.servable) ? 'available' : 'unavailable',
      legacy: source.isLegacy,
      scope: admitEntry(candidates.map((c) => c.availabilityScope), audience),
    },
    attribution: requiredAttributions(candidates.map((c) => c.attribution)),
    provenance: deriveProvenance(candidates),
    entitlement,
    pricing: { creditMultiplier: source.creditMultiplier },
  };

  // ADR 0003's discriminator, applied rather than looked up. One model means a
  // reference to that model; several means a policy over several. Zero
  // candidates is not a reference to anything, so it is a policy that currently
  // selects among nothing — which is what an emptied tier honestly is.
  //
  // The identity of the single model comes from the candidate itself, never
  // from the source: an entry cannot name a model its own routes do not carry,
  // because there is no other place for the name to come from.
  if (distinctModels === 1) {
    const [only] = candidates;
    return { ...common, kind: 'model', publisher: only.publisher, model: only.model };
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

/**
 * What decides whether a route could serve a request right now.
 *
 * Two facts, read once for the whole catalogue rather than per route: which
 * providers hold a usable credential, and which routes have an open circuit.
 */
export interface ServingConditions {
  /** Provider names holding at least one usable credential. Empty means none. */
  readonly credentialedProviders: ReadonlySet<string>;
  /** `provider\u0000modelId` for every route whose circuit is currently open. */
  readonly openCircuits: ReadonlySet<string>;
}

/**
 * Can this route answer a request?
 *
 * The credential half is the one that was missing, and it is not a nuance:
 * measured against production on 2026-08-19, `provider_keys` held ZERO rows, so
 * every one of the 58 configured provider/model pairs was unservable — and the
 * catalogue reported all thirty models available, because the only thing it
 * consulted was a circuit breaker that nothing had ever tripped. A breaker
 * records what happened to traffic; it cannot record traffic that never left.
 *
 * The circuit half is unchanged and stays second: OPEN is the only state read
 * as unusable, matching the engine's own skip, because closed, half-open and
 * never-recorded are all states it will try.
 */
export function isServable(route: ModelMapping, conditions: ServingConditions): boolean {
  if (!conditions.credentialedProviders.has(route.provider)) return false;
  return !conditions.openCircuits.has(routeKey(route.provider, route.modelId));
}

/**
 * A route, as the derivation sees it.
 *
 * One function for both loops below, so a profile entry and a model entry
 * cannot end up describing the same route differently — which is the shape of
 * bug that makes a picker and its detail panel disagree, and now also the shape
 * that would let one of them claim to be servable while the other knows better.
 */
function toCandidate(route: ModelMapping, conditions: ServingConditions): Candidate {
  return {
    modelId: route.modelId,
    provider: route.provider,
    capabilities: route.capabilities,
    publisher: route.publisher ?? null,
    model: route.model ?? null,
    servable: isServable(route, conditions),
    availabilityScope: route.availabilityScope ?? null,
    attribution: route.attribution ?? null,
  };
}

/**
 * How a route is keyed in the health table: the operator's own coordinates.
 *
 * Two strings rather than a `ModelMapping`, because the health row and the
 * routing row are different types carrying the same pair — and a key built
 * twice is a key that can be built differently.
 */
function routeKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`;
}

/**
 * Routes whose circuit breaker is currently OPEN.
 *
 * This is what makes a model entry's availability describe the model rather
 * than the profile it is served under. An alias reports available when ANY
 * route in its tier is healthy (`internal/providers/lib/alia-models.ts`), which
 * is the right answer for a policy that may take any of them and the wrong one
 * for a single model: it would call a model available because a different model
 * in the same tier is.
 *
 * Open is the only state read as unavailable, matching the engine's own skip —
 * closed, half-open and never-recorded are all states it will try. A route the
 * health table has never heard of is therefore not held against it, which is
 * correct on a cold start and is the same permissive direction
 * `getAllProviderHealth` already takes: it swallows its own read failures and
 * answers with an empty list, so an unreadable health table does not hide the
 * whole catalogue behind an infrastructure fault. The CREDENTIAL half is what
 * makes that safe — a route with no key is refused whatever the breaker says.
 */
async function loadOpenCircuits(): Promise<ReadonlySet<string>> {
  try {
    const health = await getAllProviderHealth();
    const open = new Set<string>();
    for (const row of health) {
      if (row.circuitState === 'open') open.add(routeKey(row.provider, row.modelId));
    }
    return open;
  } catch (err: unknown) {
    log.models.warn({ err }, 'Provider health unavailable; no route held against its breaker');
    return new Set<string>();
  }
}

/**
 * Both halves of "can this route answer", read once.
 *
 * ## A credential read that FAILS is not "no credentials"
 *
 * This is the one place the permissive direction would be wrong, and it is the
 * opposite of the health read above. An unreadable health table means "nothing
 * is known to be broken", which is a safe thing to assume. An unreadable
 * credential table would mean "no provider has a key", which would empty the
 * entire catalogue on a transient Postgres blip — a total product outage
 * manufactured out of one failed query.
 *
 * So a failure RETHROWS, and `buildCatalogue`'s caller turns it into the 500 it
 * already has for a catalogue it could not build. "We could not work out what
 * is available" and "nothing is available" are different answers and only one
 * of them is true, which is the same distinction `loadPlanGrants` draws when it
 * refuses to serve an unfiltered list.
 */
async function loadServingConditions(): Promise<ServingConditions> {
  const [credentialedProviders, openCircuits] = await Promise.all([
    providersWithUsableCredentials(),
    loadOpenCircuits(),
  ]);
  return { credentialedProviders, openCircuits };
}

export interface CatalogueOptions {
  /** Authenticated caller, or `null`. Decides only the `entitled` field. */
  readonly userId: string | null;
  /**
   * What kind of credential is asking. Decides which routes' availability
   * scopes admit the caller, and is therefore always applied — unlike the two
   * filters below, which a caller opts into.
   */
  readonly audience: CallerAudience;
  /** Restrict to entries granted by an active plan of this product. */
  readonly product?: PlanProduct;
  /** Restrict to entries the authenticated caller may use. Requires `userId`. */
  readonly entitledOnly?: boolean;
  /** Restrict to entries the calling client surface can be offered. */
  readonly surface?: Surface;
}

/**
 * What each filter did, so a caller can tell an applied filter from an absent
 * one and a filter from a stub.
 *
 * This block is why the two Kaana-shaped filters can ship before Kaana: an
 * availability-scope filter that withheld nothing looks exactly like one that
 * is not wired up, and the difference is `declaredRoutes` — zero means no route
 * carries a scope yet, non-zero with `withheld: 0` means every scoped route
 * admitted this caller. Region carries no counts at all because there is
 * nothing to count; it says who owns it instead.
 */
export interface CatalogueFilterReport {
  readonly availabilityScope: {
    /**
     * Candidate routes across the whole catalogue that declared a scope.
     *
     * A COUNT OF ROUTES, deliberately, and not a count of entries withheld from
     * this caller. The first says whether Kaana has classified anything yet,
     * which is what tells an unfiltered answer apart from an absent filter. The
     * second would tell a public caller how many entries Alia operates and does
     * not sell it, which is commercially sensitive and is a step toward finding
     * an internal deployment — the disclosure
     * `routes/__tests__/internal-only-access.test.ts` exists to prevent.
     */
    readonly declaredRoutes: number;
  };
  readonly platformCapability: {
    readonly surface: string | null;
    readonly withheldEntries: number;
  };
  /** Never applied here. `lib/routing/presets.ts` `DELEGATED_TO_KAANA` is the record. */
  readonly region: { readonly applied: false; readonly delegatedTo: 'kaana' };
  /** Catalogue-wide count of routes carrying a licence record that requires attribution. */
  readonly attributedRoutes: number;
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
      readonly filters: CatalogueFilterReport;
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
  const [sources, tierMappings, plans, allowedModelIds, conditions] = await Promise.all([
    getAvailableModels(),
    getTierMappings(),
    loadPlanGrants(),
    loadAllowedModelIds(options.userId),
    loadServingConditions(),
  ]);

  if (options.product !== undefined && plans === null) return { ok: false, unavailable: 'plans' };
  if (options.entitledOnly === true && allowedModelIds === null) return { ok: false, unavailable: 'entitlements' };

  const byAlias = new Map(sources.map((source) => [source.id, source] as const));
  const entries: CatalogueEntry[] = [];
  let declaredRoutes = 0;
  let attributedRoutes = 0;
  let surfaceWithheld = 0;

  /**
   * One entry per POLICY, keyed by the policy's own id.
   *
   * It used to be one entry per alias, which served thirteen entries for twelve
   * policies — `alia-v1-thinking` and `alia-v1-pro-max` are one profile under
   * two names. Iterating the preset table instead makes the bijection
   * structural: a profile appears once because it exists once.
   *
   * The alias has not stopped mattering, it has stopped being the IDENTITY —
   * and, for price and category, the SOURCE. Those two come from the preset now
   * (`lib/routing/presets.ts`), which is what lets the identifier be deleted
   * without taking the entry's price with it. What still comes off the alias
   * record is what nothing has moved yet: name, description, emoji and the
   * `isLegacy` flag the admin tool writes.
   *
   * `entitlement` is still resolved against the ALIAS because `plans.modelIds`
   * and the entitlement read model are both keyed by alias. Resolving it
   * against the profile id would silently report every entry as granted by no
   * plan.
   */
  for (const preset of ROUTING_PRESETS) {
    const alias = canonicalAliasFor(preset.id);
    if (alias === null) continue;
    const source = byAlias.get(alias);
    // An alias the runtime catalogue does not know is a preset pointing at
    // nothing. Skipping keeps the response honest rather than inventing an
    // entry with no price and no availability.
    if (source === undefined) continue;

    const candidates: Candidate[] = (tierMappings[preset.tier] ?? []).map((route) =>
      toCandidate(route, conditions),
    );
    // Counted over every candidate the catalogue looked at, including those on
    // entries a filter then removed: the question this answers is "does Kaana
    // carry this fact yet", which is a property of the data and not of the
    // response. Counting only survivors would report zero on a request whose
    // filters happened to remove every scoped route.
    for (const candidate of candidates) {
      if (candidate.availabilityScope !== null) declaredRoutes += 1;
      if (candidate.attribution !== null) attributedRoutes += 1;
    }

    const entitlement =
      plans === null ? { state: 'unknown' as const } : resolveEntitlement(alias, plans, allowedModelIds);

    if (entitlement.state === 'known') {
      if (options.product !== undefined && !entitlement.products.includes(options.product)) continue;
      if (options.entitledOnly === true && entitlement.entitled !== true) continue;
    }

    if (options.surface !== undefined && !surfaceCanOffer(options.surface, preset.category)) {
      surfaceWithheld += 1;
      continue;
    }

    const entry = buildEntry(
      {
        ...source,
        id: preset.id,
        offeredProfileId: preset.id,
        creditMultiplier: preset.creditMultiplier,
        category: preset.category,
      },
      candidates,
      entitlement,
      options.audience,
    );
    // The scope refusal, applied rather than only annotated. Unlike `product`
    // and `entitled` this is not a filter the caller asked for, so it is not
    // conditional on an option: a route the caller's credential does not admit
    // is not theirs to see whatever they asked for.
    if (entry.availability.scope.state === 'withheld') continue;
    entries.push(entry);
  }

  /**
   * One entry per individually selectable MODEL, beside the profiles.
   *
   * The product offers both, and they are different choices: a profile is
   * "answer this well and I do not mind how", a model is "answer this with
   * THIS model". `lib/routing/model-selection.ts` decides which models may be
   * named one at a time — the price-band question — and this loop only serves
   * what it decided.
   *
   * No route is counted again here. A model's deployments are the same rows the
   * profile loop already walked, so counting them twice would report a routing
   * table twice the size of the one that exists.
   */
  for (const model of classifyModels(tierMappings, sources).selectable) {
    const source = byAlias.get(model.alias);
    if (source === undefined) continue;

    const candidates = model.deployments.map((route) => toCandidate(route, conditions));
    const entitlement =
      plans === null ? { state: 'unknown' as const } : resolveEntitlement(model.alias, plans, allowedModelIds);

    if (entitlement.state === 'known') {
      if (options.product !== undefined && !entitlement.products.includes(options.product)) continue;
      if (options.entitledOnly === true && entitlement.entitled !== true) continue;
    }

    if (options.surface !== undefined && !surfaceCanOffer(options.surface, model.category)) {
      surfaceWithheld += 1;
      continue;
    }

    const entry = buildEntry(
      {
        id: model.id,
        offeredProfileId: model.profileId,
        name: model.displayName,
        /**
         * A model gets no description, and that is deliberate rather than
         * missing data. The only description available is the PROFILE's — "the
         * everyday default: quick enough, capable enough" — which describes a
         * policy, not this model, and putting it under a model's name would be
         * a claim about the model that nobody made.
         */
        description: '',
        category: model.category,
        tier: model.tier,
        creditMultiplier: model.creditMultiplier,
        // A model is not retired: `isLegacy` is a flag on an ALIAS, set by the
        // admin tool to retire an identifier the product used to advertise.
        isLegacy: false,
      },
      candidates,
      entitlement,
      options.audience,
    );
    if (entry.availability.scope.state === 'withheld') continue;
    entries.push(entry);
  }

  entries.sort((a, b) => a.pricing.creditMultiplier - b.pricing.creditMultiplier || a.id.localeCompare(b.id));
  return {
    ok: true,
    entries,
    entitlementsKnown: plans !== null,
    filters: {
      availabilityScope: { declaredRoutes },
      platformCapability: {
        surface: options.surface?.name ?? null,
        withheldEntries: surfaceWithheld,
      },
      region: { applied: false, delegatedTo: 'kaana' },
      attributedRoutes,
    },
  };
}
