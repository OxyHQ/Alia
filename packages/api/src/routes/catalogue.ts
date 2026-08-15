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
  type TokenBound,
} from '../lib/catalogue.js';

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
      structured_output: entry.capabilities.structuredOutput,
      context_window: wireTokenBound(entry.capabilities.contextWindow),
      max_output: wireTokenBound(entry.capabilities.maxOutput),
      // Which routing policy the figures above describe. A caller who sets a
      // different `fallback_policy` per request is asking a question this block
      // does not answer, and saying so is cheaper than being wrong quietly.
      under_policy: entry.capabilities.underPolicy,
    },
    availability: { status: entry.availability.status, legacy: entry.availability.legacy },
    entitlement: wireEntitlement(entry.entitlement),
    pricing: { credit_multiplier: entry.pricing.creditMultiplier },
    deprecation:
      entry.deprecation === null
        ? null
        : { deprecated_at: entry.deprecation.deprecatedAt, sunset_at: entry.deprecation.sunsetAt },
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

function parseProduct(raw: unknown): PlanProduct | null | 'invalid' {
  if (raw === undefined) return null;
  if (typeof raw !== 'string') return 'invalid';
  return (PLAN_PRODUCTS as readonly string[]).includes(raw) ? (raw as PlanProduct) : 'invalid';
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
      ...(product === null ? {} : { product }),
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
