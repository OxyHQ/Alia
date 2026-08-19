/**
 * `GET /catalogue` — the model catalogue that tells the truth about what each
 * entry is (ADR 0003, epic #139 workstream 5).
 *
 * ## Why this is a new surface and not a change to `GET /v1/models`
 *
 * ADR 0003 invariant 1 forbids serializing a routing profile as
 * `object: "model"`. `docs/migration/alias-migration-map.json` classifies all
 * THIRTEEN aliases as routing profiles and none as a concrete model reference,
 * so honouring the invariant inside `/v1/models` would change `object` on every
 * entry that endpoint serves, at once. `docs/migration/compatibility-window.md`
 * section (a) says those aliases keep working and `GET /v1/models` keeps
 * listing them, and ADR 0004 keeps `api.alia.onl/v1/*` serving *"their existing
 * request and response shapes"*. Changing the `object` value under external
 * callers is exactly the breaking change both documents exist to prevent.
 *
 * The three alternatives and what an existing caller would see:
 *
 *  - **A new FIELD on `/v1/models` entries.** Does not satisfy the invariant:
 *    the entry is still serialized `object: "model"`, so a client switching on
 *    `object` still gets the wrong answer, and the response now contradicts
 *    itself. Worse than either half alone, because it looks fixed.
 *  - **A negotiated shape on the same URL** (`Accept` or a query flag). Leaves
 *    one URL with two contradictory contracts, makes URL-keyed caching wrong,
 *    and the DEFAULT shape still violates the invariant.
 *  - **A new route under `/v1`.** ADR 0004: the compatibility surface *"gains
 *    no new capability, no new route and no new model"*. Adding one there
 *    grows the surface whose whole plan is to sunset.
 *
 * So: a new product route, mounted outside `/v1`, and `routes/v1/models.ts` is
 * not touched at all. Every existing caller sees a byte-identical response.
 *
 * ## Why `object: "routing_profile"`
 *
 * A client has to switch on this value and renaming it later is breaking, so it
 * is ADR 0003's own term spelled as one token rather than a shorthand:
 *
 *  - it is not `model` and does not contain it, so `object === 'model'` remains
 *    a total and correct test for "this is a model";
 *  - `profile` alone is ambiguous in a product that also has user profiles, and
 *    `policy` collides with ADR 0003 invariant 3's *fallback policy*, which is
 *    a different thing a caller sets per request;
 *  - snake_case matches the field convention this API already uses on model
 *    payloads (`credit_multiplier`, `required_plan`, `max_tokens`).
 *
 * Concrete model references keep `object: "model"` — the same value the ADR
 * reserves for models — so a client already testing for it keeps working
 * unchanged on the day real models appear.
 */

import { Router, type Request, type Response } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { log } from '../lib/logger.js';
import { PLAN_PRODUCTS, type PlanProduct } from '../domain/plan.js';
import {
  buildCatalogue,
  type CatalogueEntitlement,
  type CatalogueEntry,
  type CatalogueFilterReport,
  type TokenBound,
} from '../lib/catalogue.js';
import { PRODUCT_MODES, type ProductMode } from '../lib/product-modes.js';
import { resolveCallerAudience, type EntryScopeVerdict } from '../lib/availability-scope.js';
import type { RequiredAttribution } from '../lib/model-attribution.js';
import { getSurface, SURFACES, type Surface } from '../lib/surface-capability.js';

const router = Router();

interface WireTokenBound {
  guaranteed: number;
  up_to: number;
}

function wireTokenBound(bound: TokenBound | null): WireTokenBound | null {
  return bound === null ? null : { guaranteed: bound.guaranteed, up_to: bound.upTo };
}

function wireEntitlement(entitlement: CatalogueEntitlement): Record<string, unknown> {
  if (entitlement.state === 'unknown') return { state: 'unknown' };
  return {
    state: 'known',
    access: entitlement.access,
    required_plan: entitlement.requiredPlan,
    granted_by: entitlement.grantedBy,
    products: entitlement.products,
    entitled: entitlement.entitled,
  };
}

function wireScope(scope: EntryScopeVerdict): Record<string, unknown> {
  if (scope.state === 'unscoped') return { state: 'unscoped' };
  if (scope.state === 'admitted') return { state: 'admitted', values: scope.scopes };
  return { state: 'withheld', reason: scope.reason };
}

/**
 * The one field on this response permitted to name a model identity.
 *
 * Every other field is subject to the catalogue leak census in
 * `__tests__/architectureGates.test.ts` gate 5, which fails on a provider name
 * or a provider model id anywhere in the body. This one is excluded from it,
 * because an open-weight licence can require the naming as a condition of
 * serving the model at all — and the census still runs over everything else, so
 * a model id moved into a neighbouring field is caught.
 *
 * What keeps the exclusion narrow rather than a hole is `requiredAttributions`
 * in `lib/model-attribution.ts`: nothing reaches this function unless a licence
 * record says `requiresAttribution`. `requires_attribution` is serialized so a
 * reader can check that claim in the response instead of taking it on trust.
 */
function wireAttribution(attribution: RequiredAttribution): Record<string, unknown> {
  return {
    attributed_model: attribution.attributedModel,
    license: {
      license_id: attribution.license.licenseId,
      display_name: attribution.license.displayName,
      url: attribution.license.url ?? null,
      requires_attribution: attribution.license.requiresAttribution,
      commercial_use_allowed: attribution.license.commercialUseAllowed,
      acceptable_use_policy_url: attribution.license.acceptableUsePolicyUrl ?? null,
    },
  };
}

function wireFilters(filters: CatalogueFilterReport): Record<string, unknown> {
  return {
    // Routes CLASSIFIED, never entries withheld — see `CatalogueFilterReport`.
    availability_scope: { declared_routes: filters.availabilityScope.declaredRoutes },
    platform_capability: {
      surface: filters.platformCapability.surface,
      withheld_entries: filters.platformCapability.withheldEntries,
    },
    // Not applied, and saying so is the point. A region filter needs a
    // catalogue that knows which deployment is where; `lib/routing/presets.ts`
    // `DELEGATED_TO_RELAY` records that this is Relay's, and answering "no
    // region restriction" would be a stub no caller could tell from a working
    // filter with nothing to filter.
    region: { applied: false, delegated_to: filters.region.delegatedTo },
    attributed_routes: filters.attributedRoutes,
  };
}

/**
 * The one place in this package that decides an entry's `object` value.
 *
 * Driven by `entry.kind`, which `lib/catalogue.ts` derives from fan-out, so the
 * serialized type cannot disagree with the classification — there is no branch
 * here that could pick the other one.
 */
function serializeEntry(entry: CatalogueEntry): Record<string, unknown> {
  const common = {
    id: entry.id,
    display_name: entry.displayName,
    description: entry.description,
    category: entry.category,
    emoji: entry.emoji,
    chat_visible: entry.chatVisible,
    capabilities: {
      tools: entry.capabilities.tools,
      vision: entry.capabilities.vision,
      audio: entry.capabilities.audio,
      reasoning: entry.capabilities.reasoning,
      /**
       * The effort levels a client may OFFER for this entry.
       *
       * Published beside `reasoning` rather than folded into it because they
       * answer different questions and a client needs both: `reasoning` says
       * whether any route thinks, this says which levels every route can
       * honour. A client renders a control from THIS — an entry that is
       * `sometimes` with an empty list must show no control at all, and a
       * client reading only the first field would show four.
       */
      reasoning_levels: entry.capabilities.reasoningLevels,
      structured_output: entry.capabilities.structuredOutput,
      context_window: wireTokenBound(entry.capabilities.contextWindow),
      max_output: wireTokenBound(entry.capabilities.maxOutput),
      // Which routing policy the figures above describe. A caller who sets a
      // different `fallback_policy` per request is asking a question this block
      // does not answer, and saying so is cheaper than being wrong quietly.
      under_policy: entry.capabilities.underPolicy,
    },
    availability: {
      status: entry.availability.status,
      legacy: entry.availability.legacy,
      scope: wireScope(entry.availability.scope),
    },
    attribution: entry.attribution.map(wireAttribution),
    /**
     * Who published the models this entry can answer from.
     *
     * The SECOND field on this response permitted to name a model identity, and
     * narrower than the first: `attribution` may name a MODEL because a licence
     * requires it, this may name only a PUBLISHER. The census in
     * `__tests__/architectureGates.test.ts` gate 5 exempts exactly the strings
     * here that are members of `MODEL_PUBLISHERS`, so a provider model id
     * placed in this field is still caught — the exemption is over a
     * vocabulary, not over a path.
     *
     * It names no operator. Which provider serves a deployment is a property of
     * the deployment, and nothing on this response says it.
     */
    provenance: {
      publishers: entry.provenance.publishers,
      unattributed_routes: entry.provenance.unattributedRoutes,
    },
    entitlement: wireEntitlement(entry.entitlement),
    pricing: { credit_multiplier: entry.pricing.creditMultiplier },
  };

  if (entry.kind === 'model') {
    return { ...common, object: 'model', publisher: entry.publisher, model: entry.model };
  }
  return {
    ...common,
    object: 'routing_profile',
    profile_id: entry.profileId,
    selects_among: entry.selectsAmong,
  };
}

/**
 * The one place in this package that serializes a product mode.
 *
 * `object` is the constant `'product_mode'` with no branch above it, which is
 * the shape ADR 0003 invariant 1 requires and #139's architecture-test
 * checkbox *"fail when a product mode is serialized as `object: model`"*
 * measures: gate 5 drives this handler and reads the value back, so a branch
 * that could emit `model` fails there rather than shipping.
 *
 * `routing` is published rather than resolved to a profile id, because the two
 * `default` modes genuinely pin no profile and flattening them to whichever
 * profile the default happens to be today would publish a routing claim the
 * product does not make. A client renders the discriminant.
 */
function serializeMode(mode: ProductMode): Record<string, unknown> {
  return {
    id: mode.id,
    object: 'product_mode',
    label: mode.label,
    description: mode.description,
    routing:
      mode.routing.kind === 'profile'
        ? { kind: 'profile', profile_id: mode.routing.profile }
        : { kind: 'default' },
    deep_research: mode.deepResearch,
  };
}

/**
 * GET /catalogue/modes
 *
 * The product modes a person picks between — Automatic, Fast, Balanced, Maximum
 * quality, Coding and Deep research. Product configuration, not models: nothing
 * here has a publisher, a revision or a model card, and none of it is
 * serialized `object: 'model'`.
 *
 * Unauthenticated and unfiltered. A mode is a product decision that is the same
 * for everybody; what a given caller may USE is entitlement, which is annotated
 * per entry on `GET /catalogue` and belongs to the entries a mode routes
 * through rather than to the mode.
 */
router.get('/modes', (_req: Request, res: Response) => {
  res.json({ object: 'list', data: PRODUCT_MODES.map(serializeMode) });
});

function parseProduct(raw: unknown): PlanProduct | null | 'invalid' {
  if (raw === undefined) return null;
  if (typeof raw !== 'string') return 'invalid';
  return (PLAN_PRODUCTS as readonly string[]).includes(raw) ? (raw as PlanProduct) : 'invalid';
}

/**
 * The declared client surface.
 *
 * An unrecognised value is `'invalid'` and gets a 400, not a silently
 * unfiltered catalogue: a client that mistypes its own name would otherwise be
 * told nothing and receive entries it cannot render, which is the bug this
 * filter exists to prevent.
 */
function parseSurface(raw: unknown): Surface | null | 'invalid' {
  if (raw === undefined) return null;
  if (typeof raw !== 'string') return 'invalid';
  return getSurface(raw) ?? 'invalid';
}

/**
 * GET /catalogue
 *
 * Query params:
 * - `product`: restrict to entries an active plan of that Alia product grants
 *   (`alia` or `codea`, the vocabulary in `domain/plan.ts`).
 * - `entitled=true`: restrict to entries the authenticated caller may use,
 *   through `lib/plan-access.ts` — the entitlement read model ADR 0005 keeps in
 *   Alia. Requires authentication, because there is no such thing as an
 *   anonymous entitlement: answering with the free tier would be inventing one.
 * - `surface`: restrict to entries the calling client can be offered
 *   (`lib/surface-capability.ts`), so a terminal is not handed a voice entry.
 *
 * One restriction is NOT a query parameter, because it is not the caller's to
 * ask for: an entry is withheld when no route behind it has an availability
 * scope admitting the caller's own credential (#139 workstream 17). The
 * `filters` block in the response reports what each did.
 *
 * Filters that cannot be evaluated refuse with 503 rather than serving an
 * unfiltered list. Annotations that cannot be computed report `unknown`.
 */
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  const product = parseProduct(req.query.product);
  if (product === 'invalid') {
    res.status(400).json({
      error: {
        message: `Unknown product. Expected one of: ${PLAN_PRODUCTS.join(', ')}.`,
        type: 'invalid_request_error',
        param: 'product',
        code: 'invalid_product',
      },
    });
    return;
  }

  const surface = parseSurface(req.query.surface);
  if (surface === 'invalid') {
    res.status(400).json({
      error: {
        message: `Unknown surface. Expected one of: ${SURFACES.join(', ')}.`,
        type: 'invalid_request_error',
        param: 'surface',
        code: 'invalid_surface',
      },
    });
    return;
  }

  const entitledOnly = req.query.entitled === 'true';
  const userId = req.user?.id ?? null;
  if (entitledOnly && userId === null) {
    res.status(401).json({
      error: {
        message: 'Filtering by entitlement requires an authenticated request.',
        type: 'invalid_request_error',
        param: 'entitled',
        code: 'authentication_required',
      },
    });
    return;
  }

  try {
    const result = await buildCatalogue({
      userId,
      audience: resolveCallerAudience(req),
      ...(product === null ? {} : { product }),
      ...(surface === null ? {} : { surface }),
      entitledOnly,
    });

    if (!result.ok) {
      res.status(503).json({
        error: {
          message: `The ${result.unavailable} catalogue is unavailable, so this filter cannot be applied. Retry without it to receive the unfiltered catalogue.`,
          type: 'service_unavailable',
          param: result.unavailable === 'plans' ? 'product' : 'entitled',
          code: 'filter_unavailable',
        },
      });
      return;
    }

    res.json({
      object: 'list',
      data: result.entries.map(serializeEntry),
      entitlements_known: result.entitlementsKnown,
      filters: wireFilters(result.filters),
    });
  } catch (e: unknown) {
    log.models.error({ err: e }, 'Error building the catalogue');
    res.status(500).json({
      error: {
        message: 'An internal error occurred while listing the catalogue.',
        type: 'server_error',
        param: null,
        code: null,
      },
    });
  }
});

export default router;
