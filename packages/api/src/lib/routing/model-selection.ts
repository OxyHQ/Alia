/**
 * Which models a person may select one at a time, and what that costs.
 *
 * The product offers routing PROFILES — Fast, Balanced, Maximum quality — and
 * a profile chooses a model per request. This module is the other half the
 * owner asked for: naming a model directly, `<publisher>/<model>`, and getting
 * that model wherever it is deployed.
 *
 * ## The pricing problem, measured
 *
 * A credit is charged per TOTAL token at one multiplier per profile
 * (`lib/credits-manager.ts`: `billableTokens / TOKENS_PER_CREDIT * multiplier`),
 * and the multiplier is a property of the profile, not of the model that
 * answered. That is sound while the profile picks, because it picks its
 * top-ranked deployment on the normal path. It stops being sound the moment a
 * person can PIN the dearest candidate every time: `v1-pro-max` spans $2.19 to
 * $168 per million output tokens, a spread of 77x inside one multiplier.
 *
 * Re-pricing per model would mean per-model multipliers, per-model entitlement
 * rows and a billing migration. This module takes the other route, which needs
 * none of that: **the multiplier stays per profile, and only the models that
 * fall inside the band that multiplier already prices are individually
 * selectable.** Some models are therefore not selectable on their own. That is
 * the honest cost of not re-pricing, and it is stated on the catalogue rather
 * than hidden — every one of them is still reachable through the profiles that
 * route to it.
 *
 * ## The band, in three definitions
 *
 *  1. **A route's unit cost is `max(input, output)` per million tokens** — the
 *     most any single token on that route can cost. Not an average and not the
 *     output price alone, because billing does not distinguish the two: input
 *     and output tokens are one product charged at one rate, so the exposure
 *     per token is the larger of the two prices and no assumption about the
 *     mix is needed. A route missing either price has no unit cost, which is
 *     not the same as a cheap one.
 *  2. **A profile's ceiling is the unit cost of its own top-ranked route** —
 *     what the profile costs when nothing has failed, which is what its
 *     multiplier was set against.
 *  3. **A model is in band when its own top-ranked route in that profile costs
 *     no more than the ceiling.** Like for like: the normal-path price of
 *     pinning the model against the normal-path price of the profile. So
 *     choosing a model can never cost more per token than letting the profile
 *     choose, which is precisely the property that lets the multiplier stand.
 *
 * Both sides are the TOP-RANKED route rather than the dearest, and that
 * symmetry is the point. A profile already reaches its expensive candidates on
 * fallback and is priced accepting that; a pinned model reaches its own
 * expensive deployments the same way, on the same rare path.
 *
 * ## Which profile a model is served under
 *
 * A model reachable from several profiles needs exactly one home, because the
 * home decides what a person is billed, which plan grants it, and which system
 * prompt runs. The order is: a profile the product OFFERS beats one it does
 * not, then the cheaper multiplier, then the profile id. Offered comes first
 * because homing a model under a profile the chat product does not offer would
 * hide a model the product can perfectly well serve; cheapest comes next
 * because between two live answers the cheaper one is the one to give.
 *
 * ## What this module must never do
 *
 * Name an operator. `provider` is read here only to be discarded — a route's
 * price and priority are properties of the deployment, and the identity that
 * comes out the other side is `<publisher>/<model>` and nothing else.
 */

import type { AliaModel, ModelMapping } from '../gateway-client.js';
import { getAllAliaModels, getTierMappings } from '../gateway-client.js';
import {
  canonicalAliasFor,
  isProfileOffered,
  toRoutableAlias,
  type RoutingProfileId,
} from '../product-modes.js';
import { ROUTING_PRESETS } from './presets.js';
import {
  formatModelIdentity,
  modelDisplayName,
  parseModelIdentity,
  type ModelIdentity,
} from './model-identity.js';

/**
 * The most one token on a route can cost, in USD per million tokens.
 *
 * `null` when either half is missing or unusable. An unpriced route is UNKNOWN,
 * never free: treating a missing price as zero would make exactly the models
 * nobody has priced the easiest ones to pin.
 */
export function routeUnitCost(route: ModelMapping): number | null {
  const input = route.costPer1MInput;
  const output = route.costPer1MOutput;
  if (typeof input !== 'number' || typeof output !== 'number') return null;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  if (input < 0 || output < 0) return null;
  return Math.max(input, output);
}

/** One model a caller may name, with the profile whose terms it is served on. */
export interface SelectableModel {
  /** `<publisher>/<model>` — what a client sends and the catalogue publishes. */
  readonly id: string;
  readonly identity: ModelIdentity;
  readonly displayName: string;
  /**
   * The profile this model is served under. Decides price, plan and prompt.
   *
   * Typed as the preset id rather than a `string`, so a home that is not a
   * profile cannot be constructed — the entry's visibility, price and plan are
   * all read through it.
   */
  readonly profileId: RoutingProfileId;
  /** The alias that carries the home profile's facts. Never advertised. */
  readonly alias: string;
  readonly tier: string;
  readonly category: string;
  readonly creditMultiplier: number;
  /** Whether the chat picker surfaces it: the home profile's own visibility. */
  readonly chatVisible: boolean;
  /** Its routes inside the home profile, in the order the engine walks them. */
  readonly deployments: readonly ModelMapping[];
  /** The unit cost of its top-ranked route, which is what the band admitted. */
  readonly unitCost: number;
  /** The ceiling it was admitted under: the home profile's own top-ranked cost. */
  readonly bandCeiling: number;
}

/**
 * A model the routing table carries that no profile admits individually.
 *
 * Published as a first-class result rather than left as an absence, because
 * "not selectable" and "not present" are different facts and only one of them
 * is a decision anybody made.
 */
export interface WithheldModel {
  readonly id: string;
  readonly identity: ModelIdentity;
  /**
   * `unpriced` — no profile carrying it could price its top-ranked route, or
   * could price its own. `above-band` — every profile priced it, and it costs
   * more per token than that profile's own default.
   */
  readonly reason: 'unpriced' | 'above-band';
}

export interface ModelSelectionResult {
  readonly selectable: readonly SelectableModel[];
  readonly withheld: readonly WithheldModel[];
}

/**
 * A profile's facts, from `presets.ts`.
 *
 * `alias` is still here and is still the alias that SERVES the profile: it is
 * what `lib/catalogue.ts` resolves entitlement against, because `plans.modelIds`
 * is keyed by alias. What it no longer is, is where the price and the category
 * come from.
 */
interface ProfileFacts {
  readonly profileId: RoutingProfileId;
  readonly alias: string;
  readonly tier: string;
  readonly offered: boolean;
  readonly creditMultiplier: number;
  readonly category: string;
}

/** One profile's verdict on one model. */
interface Admission {
  readonly profile: ProfileFacts;
  readonly deployments: readonly ModelMapping[];
  readonly unitCost: number;
  readonly bandCeiling: number;
}

/**
 * The identity a route carries, or `null` when it carries none.
 *
 * A route arriving without both halves is not guessed at. `lib/gateway-client.ts`
 * declares both optional because Relay does not carry them yet, and inferring
 * either from `modelId` is the parse `model-publishers.ts` refuses.
 */
function routeIdentity(route: ModelMapping): ModelIdentity | null {
  const { publisher, model } = route;
  if (typeof publisher !== 'string' || publisher === '') return null;
  if (typeof model !== 'string' || model === '') return null;
  return { publisher, model };
}

/**
 * Home ordering: offered before unoffered, then cheaper, then by id.
 *
 * Total and deterministic — profile ids are unique — so a model's home never
 * depends on the order the tables happened to be read in.
 */
function preferredHome(a: Admission, b: Admission): number {
  if (a.profile.offered !== b.profile.offered) return a.profile.offered ? -1 : 1;
  if (a.profile.creditMultiplier !== b.profile.creditMultiplier) {
    return a.profile.creditMultiplier - b.profile.creditMultiplier;
  }
  return a.profile.profileId.localeCompare(b.profile.profileId);
}

/**
 * Classify every model the routing table carries.
 *
 * Pure, and driven by the two tables rather than by anything it fetches, so a
 * fixture can put a model above or below a band and the rule can be measured in
 * both directions rather than only in the direction today's prices take.
 */
export function classifyModels(
  tierMappings: Readonly<Record<string, readonly ModelMapping[]>>,
  aliases: readonly AliaModel[],
): ModelSelectionResult {
  const servedAliases = new Set(aliases.map((alias) => alias.id));
  const admissions = new Map<string, Admission[]>();
  // Every identity the table carries, so a model admitted nowhere can still be
  // reported as withheld rather than silently vanishing.
  const seen = new Map<string, ModelIdentity>();
  const priced = new Set<string>();

  for (const preset of ROUTING_PRESETS) {
    const aliasId = canonicalAliasFor(preset.id);
    if (aliasId === null) continue;
    // A preset whose alias the runtime catalogue does not know is a profile
    // pointing at nothing; it prices nothing and admits nothing. An EXISTENCE
    // check now, not a read: the profile's own facts come from the preset, and
    // the only thing the runtime catalogue still decides is whether the alias
    // this profile is served under is being served at all.
    if (!servedAliases.has(aliasId)) continue;

    const routes = Object.hasOwn(tierMappings, preset.tier) ? [...tierMappings[preset.tier]] : [];
    routes.sort((a, b) => a.priority - b.priority);
    if (routes.length === 0) continue;

    const profile: ProfileFacts = {
      profileId: preset.id,
      alias: aliasId,
      tier: preset.tier,
      offered: isProfileOffered(preset.id),
      creditMultiplier: preset.creditMultiplier,
      category: preset.category,
    };

    // The ceiling, from the route the profile takes when nothing has failed.
    const bandCeiling = routeUnitCost(routes[0]);

    // Group the profile's routes by identity, keeping walk order — so a model's
    // first entry here is the deployment the engine would try first.
    const byIdentity = new Map<string, ModelMapping[]>();
    for (const route of routes) {
      const identity = routeIdentity(route);
      if (identity === null) continue;
      const id = formatModelIdentity(identity);
      seen.set(id, identity);
      const existing = byIdentity.get(id);
      if (existing === undefined) byIdentity.set(id, [route]);
      else existing.push(route);
    }

    if (bandCeiling === null) continue;

    for (const [id, deployments] of byIdentity) {
      const unitCost = routeUnitCost(deployments[0]);
      if (unitCost === null) continue;
      priced.add(id);
      if (unitCost > bandCeiling) continue;
      const admission: Admission = { profile, deployments, unitCost, bandCeiling };
      const existing = admissions.get(id);
      if (existing === undefined) admissions.set(id, [admission]);
      else existing.push(admission);
    }
  }

  const selectable: SelectableModel[] = [];
  const withheld: WithheldModel[] = [];

  for (const [id, identity] of seen) {
    const admitted = admissions.get(id);
    if (admitted === undefined || admitted.length === 0) {
      withheld.push({ id, identity, reason: priced.has(id) ? 'above-band' : 'unpriced' });
      continue;
    }
    const home = [...admitted].sort(preferredHome)[0];
    selectable.push({
      id,
      identity,
      displayName: modelDisplayName(identity),
      profileId: home.profile.profileId,
      alias: home.profile.alias,
      tier: home.profile.tier,
      category: home.profile.category,
      creditMultiplier: home.profile.creditMultiplier,
      chatVisible: home.profile.offered,
      deployments: home.deployments,
      unitCost: home.unitCost,
      bandCeiling: home.bandCeiling,
    });
  }

  // Sorted by identity so two reads of one table agree, and so the catalogue's
  // own ordering decision stays the catalogue's.
  selectable.sort((a, b) => a.id.localeCompare(b.id));
  withheld.sort((a, b) => a.id.localeCompare(b.id));
  return { selectable, withheld };
}

/** Classify against the live tables, through the seam ADR 0001 sanctions. */
export async function loadModelSelection(): Promise<ModelSelectionResult> {
  const [tierMappings, aliases] = await Promise.all([getTierMappings(), getAllAliaModels()]);
  return classifyModels(tierMappings, aliases);
}

/**
 * What a request's `model` names.
 *
 * Four answers, and the two refusals are distinct because they send a reader to
 * different places: a `profile:` nobody defines is a policy that does not
 * exist, and a `<publisher>/<model>` the catalogue does not offer is a model
 * that is not individually selectable — which may be a model that exists and is
 * only reachable through a profile.
 */
export type RequestedModel =
  | { readonly kind: 'alias'; readonly alias: string }
  | { readonly kind: 'model'; readonly alias: string; readonly identity: ModelIdentity }
  | { readonly kind: 'unknown-profile'; readonly requested: string }
  | { readonly kind: 'unknown-model'; readonly requested: string };

/**
 * Resolve a requested identifier at the boundary, once.
 *
 * The three shapes a caller may send, in the order they are tested:
 *
 *  - **`profile:*`** — the vocabulary the catalogue publishes for a policy.
 *    Becomes the alias carrying that profile's facts, exactly as before.
 *  - **`<publisher>/<model>`** — a model, and the new one. It becomes its HOME
 *    profile's alias plus the identity, so everything downstream keeps reading
 *    one alias for price, plan, prompt and tier, and only the fallback engine
 *    learns that the candidate set is narrowed to one model.
 *  - **anything else** — passes through untouched, which is what keeps the
 *    thirteen legacy aliases and every installed SDK copy working.
 *
 * A slashed identifier that names no selectable model is REFUSED rather than
 * passed through. Passing it through would reach a resolver whose refusal talks
 * about the alias list, which is the wrong list for a caller who just named a
 * model.
 */
export async function resolveRequestedModel(requested: string): Promise<RequestedModel> {
  const identity = parseModelIdentity(requested);
  if (identity === null) {
    const alias = toRoutableAlias(requested);
    return alias === null ? { kind: 'unknown-profile', requested } : { kind: 'alias', alias };
  }

  const { selectable } = await loadModelSelection();
  const found = selectable.find((model) => model.id === requested);
  if (found === undefined) return { kind: 'unknown-model', requested };
  return { kind: 'model', alias: found.alias, identity: found.identity };
}
