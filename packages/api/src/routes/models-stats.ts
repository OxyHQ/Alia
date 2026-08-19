/**
 * Models Statistics API
 *
 * Provides aggregated statistics for Alia virtual models.
 *
 * Customer-facing analytics, so route detail is concealed here. The operator
 * view of the same data lives on the admin surfaces, which name the deployment
 * deliberately — see `lib/errors/sanitize.ts`.
 *
 * ## A model that has served nothing does not report 100%
 *
 * Measured on `api.alia.onl` on 2026-08-19, unauthenticated:
 *
 *     {"id":"alia-lite", …, "avgLatencyMs":0, "uptime":100,
 *      "successRate":100, "totalRequests":0, "isHealthy":true}
 *
 * `totalRequests: 0` beside `uptime: 100` and `successRate: 100`, in public, for
 * every model. The detail route put `lastSuccess: null` in the same object. That
 * is not one of two defensible readings of the data — zero requests and a
 * perfect success rate cannot both describe the same model, so the response
 * contradicted itself.
 *
 * Two `: 100` fallbacks produced it, and a third mistake fed them:
 *
 *  - `successRate = totalRequests > 0 ? weighted : 100`;
 *  - `uptime = totalProviders > 0 ? healthy / total * 100 : 100`;
 *  - `healthy` counted `health.isHealthy`, which DEFAULTS to true for a
 *    provider nothing has ever called — the same defect `routes/health.ts`
 *    documents. So even a model with one real provider among fifteen cold ones
 *    reported 100% uptime.
 *
 * Absence is now reported as absence. {@link ModelObservations} is a
 * discriminated union rather than a set of nullable fields, so `observed: false`
 * CANNOT carry a number and `totalRequests: 0` beside a success rate is not a
 * value this module can construct. That is a property of the type, which is
 * where a property the type system can enforce belongs.
 *
 * Nothing else about the contract moved: the thresholds behind `isHealthy` are
 * the ones that were there, there is no staleness window, and a model that has
 * genuinely served still reports its real numbers.
 *
 * ## Reading this route no longer WRITES
 *
 * It called `getProviderHealth(provider, modelId)` once per tier mapping per
 * model, and that lands in `getOrCreateProviderHealth`, which INSERTS a default
 * row when none is found. So one unauthenticated request to a public stats route
 * manufactured a `provider_health` row for every mapping — which is where
 * production's 26 healthy-looking never-called rows came from.
 *
 * One `getAllProviderHealth()` now feeds both handlers, indexed by
 * `provider:modelId`. It inserts nothing, it replaces an N-per-model query
 * storm with a single read, and a missing key means what it should: never
 * observed.
 *
 * ## The response carries no routing detail
 *
 * The endpoint is public and unauthenticated. The detail route used to return
 * `backingProviders` and `healthyProviders` — counts of the UPSTREAM PROVIDERS
 * behind an Alia model, `16` for `alia-lite` as measured above. Those are route
 * detail by any reading, and they are gone. Only Alia-branded identifiers and
 * aggregate observations remain.
 */

import { Router, Request, Response } from 'express';
import { getAllAliaModels } from '../lib/chat-core.js';
import { getTierMappings, getAllProviderHealth, type HealthMetrics } from '../lib/gateway-client.js';
import { log } from '../lib/logger.js';

const router = Router();

/**
 * What has actually been observed of the providers backing one model.
 *
 * The union is the enforcement. Nullable fields on one flat interface would let
 * `{ totalRequests: 0, successRate: 100 }` typecheck, and that object is the
 * bug — so the shape that can express it does not exist. A caller must narrow on
 * `observed` before it can read a number, and the `false` arm pins
 * `totalRequests` to the literal `0`.
 */
type ModelObservations =
  | {
      readonly observed: false;
      readonly totalRequests: 0;
      readonly avgLatencyMs: null;
      readonly uptime: null;
      readonly successRate: null;
      readonly isHealthy: null;
    }
  | {
      readonly observed: true;
      readonly totalRequests: number;
      readonly avgLatencyMs: number;
      readonly uptime: number;
      readonly successRate: number;
      readonly isHealthy: boolean;
    };

/** Nothing has been observed. The only value the `false` arm can take. */
const NOTHING_OBSERVED: ModelObservations = {
  observed: false,
  totalRequests: 0,
  avgLatencyMs: null,
  uptime: null,
  successRate: null,
  isHealthy: null,
};

/** `provider_health` rows by `provider:modelId`. A miss means never recorded. */
type HealthIndex = ReadonlyMap<string, HealthMetrics>;

async function indexProviderHealth(): Promise<HealthIndex> {
  const rows = await getAllProviderHealth();
  return new Map(rows.map((row) => [`${row.provider}:${row.modelId}`, row]));
}

/**
 * Fold one model's provider mappings into what can honestly be said about it.
 *
 * `serving` requires POSITIVE EVIDENCE — a recorded success AND no adverse
 * verdict from the circuit breaker. `is_healthy` alone is the defaulted-true
 * flag that produced the 100% this module exists to stop reporting, so it is
 * necessary here and never sufficient.
 *
 * The denominator is every mapping, including those with no row at all: a
 * provider that has never answered is not serving, and dropping it would make
 * uptime a fraction of whatever happened to have been tried.
 */
function observeModel(
  mappings: readonly { provider: string; modelId: string }[],
  health: HealthIndex,
): ModelObservations {
  let weightedLatency = 0;
  let weightedSuccessRate = 0;
  let totalRequests = 0;
  let serving = 0;

  for (const mapping of mappings) {
    const row = health.get(`${mapping.provider}:${mapping.modelId}`);
    if (row === undefined) continue;

    if (row.lastSuccess !== null && row.isHealthy) serving += 1;
    if (row.totalRequests > 0) {
      weightedLatency += row.averageLatencyMs * row.totalRequests;
      weightedSuccessRate += row.successRate * row.totalRequests;
      totalRequests += row.totalRequests;
    }
  }

  // No request has ever reached any provider behind this model, so every
  // average below would be a division with nothing in it. Absence, not 100.
  if (totalRequests === 0) return NOTHING_OBSERVED;

  const uptime = mappings.length > 0 ? (serving / mappings.length) * 100 : 0;
  const successRate = weightedSuccessRate / totalRequests;

  return {
    observed: true,
    totalRequests,
    avgLatencyMs: Math.round(weightedLatency / totalRequests),
    uptime: Math.round(uptime * 100) / 100,
    successRate: Math.round(successRate * 100) / 100,
    // The thresholds are the ones this route already used. Unchanged on purpose:
    // what was wrong was the inputs, not where the line was drawn.
    isHealthy: uptime >= 50 && successRate >= 50,
  };
}

interface ModelStats {
  id: string;
  name: string;
  description: string;
  tier: string;
  category: string;
  creditMultiplier: number;

  /** Null until something has been observed. See {@link ModelObservations}. */
  avgLatencyMs: number | null;
  /** 0-100 percentage, or null when nothing has been observed. */
  uptime: number | null;
  /** 0-100 percentage, or null when nothing has been observed. */
  successRate: number | null;
  totalRequests: number;
  isHealthy: boolean | null;

  // Capabilities
  supportsTools: boolean;
  supportsVision: boolean;
  maxTokens: number;
}

/**
 * GET /api/models/stats
 * Returns aggregated statistics for all Alia models
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const models = await getAllAliaModels();
    const TIER_MODEL_MAPPINGS = await getTierMappings();
    // One read for every model, and it inserts nothing. See the module comment.
    const health = await indexProviderHealth();
    const modelStats: ModelStats[] = [];

    for (const model of models) {
      const observations = observeModel(TIER_MODEL_MAPPINGS[model.tier] || [], health);

      modelStats.push({
        id: model.id,
        name: model.name,
        description: model.description,
        tier: model.tier,
        category: model.category,
        creditMultiplier: model.creditMultiplier,
        avgLatencyMs: observations.avgLatencyMs,
        uptime: observations.uptime,
        successRate: observations.successRate,
        totalRequests: observations.totalRequests,
        isHealthy: observations.isHealthy,
        supportsTools: model.supportsTools,
        supportsVision: model.supportsVision,
        maxTokens: model.maxTokens
      });
    }

    // Sort by category, then by tier
    modelStats.sort((a, b) => {
      if (a.category !== b.category) {
        return a.category === 'general' ? -1 : 1;
      }
      return a.creditMultiplier - b.creditMultiplier;
    });

    res.json({
      models: modelStats,
      count: modelStats.length,
      timestamp: new Date().toISOString()
    });
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error fetching model stats');
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch model statistics'
      }
    });
  }
});

/**
 * GET /api/models/stats/:modelId
 * Returns detailed statistics for a specific Alia model
 */
router.get('/stats/:modelId', async (req: Request, res: Response) => {
  try {
    const { modelId } = req.params;
    const models = await getAllAliaModels();
    const model = models.find(m => m.id === modelId);

    if (!model) {
      return res.status(404).json({
        error: {
          code: 'MODEL_NOT_FOUND',
          message: `Model '${modelId}' not found`
        }
      });
    }

    const TIER_MODEL_MAPPINGS = await getTierMappings();
    const mappings = TIER_MODEL_MAPPINGS[model.tier] || [];
    const health = await indexProviderHealth();
    const observations = observeModel(mappings, health);

    // The most recent activity across the model's providers. Read from RECORDED
    // rows only, so a mapping nothing has called contributes no timestamp
    // rather than a default one.
    let lastSuccess: Date | null = null;
    let lastFailure: Date | null = null;
    for (const mapping of mappings) {
      const row = health.get(`${mapping.provider}:${mapping.modelId}`);
      if (row === undefined) continue;
      if (row.lastSuccess !== null && (lastSuccess === null || row.lastSuccess > lastSuccess)) {
        lastSuccess = row.lastSuccess;
      }
      if (row.lastFailure !== null && (lastFailure === null || row.lastFailure > lastFailure)) {
        lastFailure = row.lastFailure;
      }
    }

    res.json({
      model: {
        id: model.id,
        name: model.name,
        description: model.description,
        tier: model.tier,
        category: model.category,
        creditMultiplier: model.creditMultiplier,
        supportsTools: model.supportsTools,
        supportsVision: model.supportsVision,
        maxTokens: model.maxTokens
      },
      // No `backingProviders`/`healthyProviders`: those counted UPSTREAM
      // PROVIDERS on a public unauthenticated route. See the module comment.
      stats: {
        avgLatencyMs: observations.avgLatencyMs,
        uptime: observations.uptime,
        successRate: observations.successRate,
        totalRequests: observations.totalRequests,
        isHealthy: observations.isHealthy,
        lastSuccess: lastSuccess?.toISOString() ?? null,
        lastFailure: lastFailure?.toISOString() ?? null
      },
      timestamp: new Date().toISOString()
    });
  } catch (error: unknown) {
    log.models.error({ err: error }, 'Error fetching model stats');
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Failed to fetch model statistics'
      }
    });
  }
});

export default router;
