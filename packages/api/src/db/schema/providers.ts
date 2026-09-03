/**
 * The retained routing catalogue: which Kaana routing profile a caller asks
 * for and the historical provider-model mapping awaiting Kaana reconciliation.
 *
 * Four tables. Three are the retained model catalogue; `external_models` is
 * unrelated to routing and is here because it is the other
 * thing in this service called a "model" — a read-only mirror of a third party's
 * public leaderboard, which nothing in the completion path consults.
 *
 * ## Provider names are INTERNAL, in the database as everywhere else
 *
 * `model_configs.provider` and `routing_profile_provider_mappings.provider`
 * hold historical provider slugs.
 * They are the same class of value as `cost_entries.actual_provider`: a caller
 * asks for `kaana-v1` and must never learn who served it. Nothing selected from
 * these columns may reach a user-facing response, an error message or a public
 * API surface.
 *
 * ## Adding a provider is now a migration, in the same PR
 *
 * `PROVIDER_NAMES` renders a CHECK on all three of those columns. Appending to
 * that tuple therefore changes the database, not just TypeScript: ship the
 * `pre` migration widening the CHECK in the SAME commit as the tuple, or the
 * first write naming the new provider fails in the routing path. This is the
 * `ALL_CURRENCY_CODES` rule from Mercaria, arrived at for the same reason.
 *
 * ## Value tuples come from the Mongoose models, never retyped
 *
 * Both stores exist until cutover, so a CHECK written from a second copy of a
 * tuple can disagree with the validator that has been guarding the same column
 * for years. `ROUTING_TIERS` was the sharp case: it was two identical thirteen-value
 * literals in two model files, and unifying it was a precondition of rendering
 * one CHECK from it.
 */

import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';
import { ROUTING_TIERS } from '../../internal/providers/lib/routing-tiers.js';
import { PROVIDER_NAMES } from '../../internal/providers/lib/provider-names.js';
import { MODEL_PRICING_TIERS } from '../../domain/model-config.js';

/**
 * One provider model this service knows how to call.
 *
 * The nested `capabilities`, `limits`, `pricing` and `defaultConfig`
 * sub-documents become COLUMNS, per the `routing_logs` precedent: each has a
 * fixed shape this service owns, so `jsonb` would only hide them from a CHECK
 * and from the planner.
 *
 * **`pricing_cost_per_1m_*` is `double precision`, and that is the
 * `cost_entries.cost_usd` decision applied to the rate rather than the total.**
 * Oxy's money convention is `bigint` minor units, which fits an amount somebody
 * is charged; a published per-million-token rate is a fraction of a cent with no
 * minor unit to hold it. These columns feed `cost_entries.cost_usd` and share its
 * caveats: sum for display, never compare for exactness.
 *
 * `UNIQUE(provider, model_id)` is the arbiter every seed upsert infers on.
 *
 * **There is no `alia_tier` column, and re-adding one cannot be made correct.**
 * A row is one `(provider, model_id)` pair and `TIER_MODEL_MAPPINGS` is
 * many-to-many: 29 of the 69 pairs served more than one tier when it was
 * counted, `google/gemini-2.5-pro` serving seven, and that number can only rise
 * as tiers are added. One column over a many-to-many relation records whichever
 * tier the seeder wrote LAST, so the value was never a fact about the row. The
 * visible cost in production was `v1-voice`: both its mappings are byte-identical
 * to `v1-voice-pro`'s, `v1-voice-pro` is iterated second, and the tier therefore
 * had ZERO rows in a table that is supposed to describe it. Nothing at request
 * time ever read the column — routing resolves from the in-memory
 * `TIER_MODEL_MAPPINGS` — so the loss was silent. Which provider models serve a
 * tier is `routing_profile_provider_mappings`, a child table that can hold the
 * relation the routing table actually has. See `docs/alias-layer-audit.mdx` §1.
 */
export const modelConfigs = pgTable(
  'model_configs',
  {
    /** Mongo `_id`, preserved verbatim; new rows mint a uuid v7 in the same column. */
    id: generatedId(),
    modelId: text().notNull(),
    provider: text({ enum: PROVIDER_NAMES as unknown as [string, ...string[]] }).notNull(),
    displayName: text().notNull(),
    priority: integer(),
    qualityScore: integer(),

    capabilitiesVision: boolean().notNull().default(false),
    capabilitiesAudio: boolean().notNull().default(false),
    capabilitiesCodeExecution: boolean().notNull().default(false),
    capabilitiesWebSearch: boolean().notNull().default(false),
    capabilitiesComputerUse: boolean().notNull().default(false),
    capabilitiesThinking: boolean().notNull().default(false),
    capabilitiesStreaming: boolean().notNull().default(true),
    capabilitiesFunctionCalling: boolean().notNull().default(true),
    capabilitiesJsonMode: boolean().notNull().default(false),
    capabilitiesPromptCaching: boolean().notNull().default(false),

    limitsMaxContextTokens: integer().notNull(),
    limitsMaxOutputTokens: integer().notNull(),
    limitsMaxImages: integer(),
    limitsMaxAudioSeconds: integer(),

    pricingTier: text({ enum: MODEL_PRICING_TIERS as unknown as [string, ...string[]] }).notNull(),
    pricingCostPer1mInput: doublePrecision('pricing_cost_per_1m_input').notNull(),
    pricingCostPer1mOutput: doublePrecision('pricing_cost_per_1m_output').notNull(),
    pricingCostPer1mCachedInput: doublePrecision('pricing_cost_per_1m_cached_input'),
    pricingAverageLatencyMs: integer().notNull(),

    defaultConfigTemperature: doublePrecision(),
    defaultConfigTopP: doublePrecision(),
    defaultConfigMaxTokens: integer(),
    defaultConfigSystemPrompt: text(),

    isActive: boolean().notNull().default(true),
    isDeprecated: boolean().notNull().default(false),
    deprecationDate: timestamptz(),
    replacementModelId: text(),

    description: text(),
    providerUrl: text(),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('model_configs_provider_model_id_key').on(t.provider, t.modelId),
    index('model_configs_active_deprecated_idx').on(t.isActive, t.isDeprecated),
    index('model_configs_provider_idx').on(t.provider),
    checkOneOf('model_configs_provider_check', t.provider, PROVIDER_NAMES),
    checkOneOf('model_configs_pricing_tier_check', t.pricingTier, MODEL_PRICING_TIERS),
    // Mongoose min/max, preserved. These are DOMAIN invariants — a quality score
    // outside 0..100 silently corrupts the ordering `getNextProvider` depends
    // on — not the input-shaping `maxlength` rules, which are deliberately not
    // ported. See CONVENTIONS.md §"Which Mongoose validations became CHECKs".
    check('model_configs_priority_range_check', sql`${t.priority} is null or (${t.priority} between 1 and 100)`),
    check(
      'model_configs_quality_score_range_check',
      sql`${t.qualityScore} is null or (${t.qualityScore} between 0 and 100)`,
    ),
  ],
);

/**
 * A virtual Kaana routing profile — `kaana-v1`, `kaana-lite` — and the tier it belongs to.
 *
 * `aggregated_capabilities_*` are columns for the same reason
 * `model_configs.capabilities_*` are. `features` stays a `text[]`: a small
 * unordered display list read whole with the row, exactly the
 * `reports.categories` shape, and with no closed value set to CHECK it against.
 *
 * The provider mappings do NOT live here — see `routingProfileProviderMappings`.
 */
export const routingProfiles = pgTable(
  'routing_profiles',
  {
    id: generatedId(),
    /**
     * `kaana-v1`, `kaana-lite`. Mongoose declared `lowercase: true`, which is a
     * SETTER rather than a validator: it normalises on `save()` and does not run
     * on `updateOne`. No CHECK asserts the case here, because one would fail on
     * any row a non-validating write path already stored differently — the
     * backfill audits it.
     */
    routingProfileId: text().notNull(),
    displayName: text().notNull(),
    tier: text({ enum: ROUTING_TIERS as unknown as [string, ...string[]] }).notNull(),
    description: text(),
    features: text().array().notNull().default(sql`'{}'::text[]`),

    /** Cost multiplier against the base rate. 1.0 is base, 1.5 is 50% more. */
    creditMultiplier: doublePrecision().notNull().default(1),
    isFreeTier: boolean().notNull().default(true),

    aggregatedCapabilitiesVision: boolean().notNull().default(false),
    aggregatedCapabilitiesAudio: boolean().notNull().default(false),
    aggregatedCapabilitiesCodeExecution: boolean().notNull().default(false),
    aggregatedCapabilitiesWebSearch: boolean().notNull().default(false),
    aggregatedCapabilitiesThinking: boolean().notNull().default(false),

    isActive: boolean().notNull().default(true),
    isDeprecated: boolean().notNull().default(false),
    isLegacy: boolean().notNull().default(false),
    deprecationDate: timestamptz(),
    replacementModelId: text(),

    totalRequests: integer().notNull().default(0),
    totalTokens: integer().notNull().default(0),
    averageLatencyMs: integer().notNull().default(0),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('routing_profiles_routing_profile_id_key').on(t.routingProfileId),
    index('routing_profiles_tier_active_idx').on(t.tier, t.isActive),
    index('routing_profiles_active_deprecated_idx').on(t.isActive, t.isDeprecated),
    checkOneOf('routing_profiles_tier_check', t.tier, ROUTING_TIERS),
    check(
      'routing_profiles_credit_multiplier_range_check',
      sql`${t.creditMultiplier} between 0.1 and 10`,
    ),
  ],
);

/**
 * Which provider models can serve a Kaana routing profile, in preference order.
 *
 * **A child table, not `jsonb`, and this is the one place that decision is not
 * obvious.** `fallback_events.attempts` is `jsonb` because it is an ordered list
 * read whole for display which addresses nothing; this array looked identical in
 * Mongo and is not the same thing. Each element carries a REFERENCE to
 * `model_configs` and a per-element `is_active` toggle, so `jsonb` would hide a
 * foreign key inside an opaque value and leave "does this mapping point at a
 * model that still exists" unanswerable in SQL.
 *
 * `ON DELETE CASCADE` on both sides, and the `model_config_id` one is a
 * deliberate behaviour CHANGE. Under Mongo, deleting a `ModelConfig` left the
 * mapping behind pointing at nothing, and `getNextProvider` would hand the
 * router a provider row whose configuration no longer existed. Removing the
 * mapping with the configuration is what the routing code already assumes.
 *
 * `provider` and `model_id` are DENORMALISED from `model_configs` — Mongo stored
 * them on the mapping and the router reads them without a join. They are kept so
 * the port changes no read path, and `provider` carries the same CHECK as its
 * source column.
 */
export const routingProfileProviderMappings = pgTable(
  'routing_profile_provider_mappings',
  {
    id: generatedId(),
    routingProfileId: text().notNull(),
    modelConfigId: text().notNull(),
    provider: text({ enum: PROVIDER_NAMES as unknown as [string, ...string[]] }).notNull(),
    modelId: text().notNull(),
    /** 1 is highest; the router tries ascending. */
    priority: integer().notNull(),
    qualityScore: integer().notNull(),
    isActive: boolean().notNull().default(true),
  },
  (t) => [
    foreignKey({
      name: 'routing_profile_provider_mappings_routing_profile_id_fk',
      columns: [t.routingProfileId],
      foreignColumns: [routingProfiles.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'routing_profile_provider_mappings_model_config_id_fk',
      columns: [t.modelConfigId],
      foreignColumns: [modelConfigs.id],
    }).onDelete('cascade'),
    /**
     * One mapping per (Kaana routing profile, provider model). Mongo could not express this
     * — a sub-document array has no unique index — so the seed's whole-array
     * `$set` was what kept it true. A rewrite that appends instead of replacing
     * would have produced duplicates silently.
     */
    uniqueIndex('routing_profile_provider_mappings_model_config_key').on(t.routingProfileId, t.modelConfigId),
    index('routing_profile_provider_mappings_routing_profile_priority_idx').on(t.routingProfileId, t.priority),
    checkOneOf('routing_profile_provider_mappings_provider_check', t.provider, PROVIDER_NAMES),
    check('routing_profile_provider_mappings_priority_range_check', sql`${t.priority} between 1 and 100`),
    check(
      'routing_profile_provider_mappings_quality_score_range_check',
      sql`${t.qualityScore} between 0 and 100`,
    ),
  ],
);

/**
 * A third party's public model leaderboard, mirrored.
 *
 * Nothing in the completion path reads this — `scripts/sync-zeroeval.ts` writes
 * it and `routes/external-models.ts` serves it. It is NOT the routing catalogue
 * and must never be joined to one: `model_configs` is what this service can
 * actually call.
 *
 * **The eighteen benchmarks are COLUMNS, not `jsonb`, and the read path is why.**
 * `routes/external-models.ts` filters on four of them being non-null and sorts
 * by two, so they have a queryable identity — the test `jsonb` is reserved for
 * failing. The cost is honest: when the upstream publishes a nineteenth
 * benchmark, that is an additive migration rather than a silent shape change.
 *
 * `release_date`, `announcement_date` and `knowledge_cutoff` stay `text`. The
 * upstream sends partial dates (`2025-03`, `2025`), which no date type accepts
 * and which a parse would have to invent a day for.
 */
export const externalModels = pgTable(
  'external_models',
  {
    id: generatedId(),
    modelId: text().notNull(),
    name: text().notNull(),
    organization: text().notNull(),
    organizationId: text().notNull(),
    organizationCountry: text(),
    /**
     * Parameter count. `double precision` rather than an integer type: the
     * upstream publishes fractional values in billions for some models, and an
     * exact count would exceed `integer` for most of them anyway.
     */
    params: doublePrecision(),
    context: integer(),
    canonicalModelId: text(),
    releaseDate: text(),
    announcementDate: text(),
    multimodal: boolean().notNull().default(false),
    license: text(),
    knowledgeCutoff: text(),
    /** Published per-token prices. `double precision`, per the table comment. */
    inputPrice: doublePrecision(),
    outputPrice: doublePrecision(),
    throughput: doublePrecision(),
    latency: doublePrecision(),

    benchmarkAime2025: doublePrecision('benchmark_aime_2025'),
    benchmarkHle: doublePrecision('benchmark_hle'),
    benchmarkGpqa: doublePrecision('benchmark_gpqa'),
    benchmarkSweBenchVerified: doublePrecision('benchmark_swe_bench_verified'),
    benchmarkMmmu: doublePrecision('benchmark_mmmu'),
    benchmarkSimpleqa: doublePrecision('benchmark_simpleqa'),
    benchmarkOsworld: doublePrecision('benchmark_osworld'),
    benchmarkBrowsecomp: doublePrecision('benchmark_browsecomp'),
    benchmarkToolathlon: doublePrecision('benchmark_toolathlon'),
    benchmarkTerminalBench: doublePrecision('benchmark_terminal_bench'),
    benchmarkTauBenchRetail: doublePrecision('benchmark_tau_bench_retail'),
    benchmarkArcAgiV2: doublePrecision('benchmark_arc_agi_v2'),
    benchmarkMmmlu: doublePrecision('benchmark_mmmlu'),
    benchmarkCharxivR: doublePrecision('benchmark_charxiv_r'),
    benchmarkMmmuPro: doublePrecision('benchmark_mmmu_pro'),
    benchmarkScreenspotPro: doublePrecision('benchmark_screenspot_pro'),
    benchmarkMcpAtlas: doublePrecision('benchmark_mcp_atlas'),
    benchmarkFrontiermath: doublePrecision('benchmark_frontiermath'),

    /**
     * Which upstream this row came from. No CHECK: the Mongoose field is a bare
     * `String` defaulting to `'zeroeval'` with no enum, so the
     * `auth_health_metrics.method` rule applies.
     */
    source: text().notNull().default('zeroeval'),
    lastSyncedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('external_models_model_id_key').on(t.modelId),
    index('external_models_organization_model_idx').on(t.organizationId, t.modelId),
    index('external_models_source_idx').on(t.source),
  ],
);
