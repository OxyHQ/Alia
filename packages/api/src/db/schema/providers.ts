/**
 * The routing catalogue: which Alia model a caller asks for, which provider
 * models can serve it, and which credentials are allowed to.
 *
 * Five tables. Four are the model catalogue and its credentials;
 * `external_models` is unrelated to routing and is here because it is the other
 * thing in this service called a "model" — a read-only mirror of a third party's
 * public leaderboard, which nothing in the completion path consults.
 *
 * ## Provider names are INTERNAL, in the database as everywhere else
 *
 * `model_configs.provider`, `provider_keys.provider` and
 * `alia_model_provider_mappings.provider` hold `openai`, `anthropic`, and so on.
 * They are the same class of value as `cost_entries.actual_provider`: a caller
 * asks for `alia-v1` and must never learn who served it. Nothing selected from
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
 * for years. `ALIA_TIERS` was the sharp case: it was two identical thirteen-value
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
import { organizations } from './organizations';
import { ALIA_TIERS } from '../../internal/providers/lib/alia-tiers.js';
import { PROVIDER_NAMES } from '../../internal/providers/lib/provider-names.js';
import { MODEL_PRICING_TIERS } from '../../value-sets/model-config.js';
import { PROVIDER_KEY_ENVIRONMENTS, PROVIDER_KEY_ROTATION_SCHEDULES, PROVIDER_KEY_TIERS } from '../../value-sets/provider-key.js';

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
 */
export const modelConfigs = pgTable(
  'model_configs',
  {
    /** Mongo `_id`, preserved verbatim; new rows mint a uuid v7 in the same column. */
    id: generatedId(),
    modelId: text().notNull(),
    provider: text({ enum: PROVIDER_NAMES as unknown as [string, ...string[]] }).notNull(),
    displayName: text().notNull(),
    /** Which Alia tier this provider model serves. Absent means it serves none. */
    aliaTier: text({ enum: ALIA_TIERS as unknown as [string, ...string[]] }),
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
    index('model_configs_alia_tier_priority_idx').on(t.aliaTier, t.priority),
    index('model_configs_active_deprecated_idx').on(t.isActive, t.isDeprecated),
    index('model_configs_provider_idx').on(t.provider),
    checkOneOf('model_configs_provider_check', t.provider, PROVIDER_NAMES),
    checkOneOf('model_configs_alia_tier_check', t.aliaTier, ALIA_TIERS),
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
 * A virtual Alia model — `alia-v1`, `alia-lite` — and the tier it belongs to.
 *
 * `aggregated_capabilities_*` are columns for the same reason
 * `model_configs.capabilities_*` are. `features` stays a `text[]`: a small
 * unordered display list read whole with the row, exactly the
 * `reports.categories` shape, and with no closed value set to CHECK it against.
 *
 * The provider mappings do NOT live here — see `aliaModelProviderMappings`.
 */
export const aliaModels = pgTable(
  'alia_models',
  {
    id: generatedId(),
    /**
     * `alia-v1`, `alia-lite`. Mongoose declared `lowercase: true`, which is a
     * SETTER rather than a validator: it normalises on `save()` and does not run
     * on `updateOne`. No CHECK asserts the case here, because one would fail on
     * any row a non-validating write path already stored differently — the
     * backfill audits it.
     */
    aliasModelId: text().notNull(),
    displayName: text().notNull(),
    tier: text({ enum: ALIA_TIERS as unknown as [string, ...string[]] }).notNull(),
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
    uniqueIndex('alia_models_alias_model_id_key').on(t.aliasModelId),
    index('alia_models_tier_active_idx').on(t.tier, t.isActive),
    index('alia_models_active_deprecated_idx').on(t.isActive, t.isDeprecated),
    checkOneOf('alia_models_tier_check', t.tier, ALIA_TIERS),
    check(
      'alia_models_credit_multiplier_range_check',
      sql`${t.creditMultiplier} between 0.1 and 10`,
    ),
  ],
);

/**
 * Which provider models can serve an Alia model, in preference order.
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
export const aliaModelProviderMappings = pgTable(
  'alia_model_provider_mappings',
  {
    id: generatedId(),
    aliaModelId: text().notNull(),
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
      name: 'alia_model_provider_mappings_alia_model_id_fk',
      columns: [t.aliaModelId],
      foreignColumns: [aliaModels.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'alia_model_provider_mappings_model_config_id_fk',
      columns: [t.modelConfigId],
      foreignColumns: [modelConfigs.id],
    }).onDelete('cascade'),
    /**
     * One mapping per (Alia model, provider model). Mongo could not express this
     * — a sub-document array has no unique index — so the seed's whole-array
     * `$set` was what kept it true. A rewrite that appends instead of replacing
     * would have produced duplicates silently.
     */
    uniqueIndex('alia_model_provider_mappings_model_config_key').on(t.aliaModelId, t.modelConfigId),
    index('alia_model_provider_mappings_alia_model_priority_idx').on(t.aliaModelId, t.priority),
    checkOneOf('alia_model_provider_mappings_provider_check', t.provider, PROVIDER_NAMES),
    check('alia_model_provider_mappings_priority_range_check', sql`${t.priority} between 1 and 100`),
    check(
      'alia_model_provider_mappings_quality_score_range_check',
      sql`${t.qualityScore} between 0 and 100`,
    ),
  ],
);

/**
 * A provider credential, its rate limits, and its rotation state.
 *
 * ## `key` holds a PLAINTEXT provider API key
 *
 * Not a hash — `key_hash` is that. `lib/key-manager.ts` reads this column to
 * make the upstream call, so the secret is genuinely at rest here, exactly as it
 * was in Mongo. Consequences for whoever writes the repository:
 *
 *  - never `select()` this table whole; name the columns, and leave `key` out of
 *    every projection that is not the one call that must sign a request;
 *  - it must never appear in a log line, an error, a metric label or an admin
 *    response — the routes today expose `key_prefix`, which exists for that;
 *  - `key_hash` is NOT a safer alias for it. A hash of a credential is an
 *    exact-match oracle, so it is equally protected.
 *
 * There is no protected-column mechanism in this service yet. This comment and
 * CONVENTIONS.md are the whole of it until the repository lands, which is why
 * both say it rather than one.
 *
 * ## `spent_usd` / `credit_limit_usd` are `double precision`
 *
 * Same reasoning as `model_configs.pricing_cost_per_1m_*`: `spent_usd`
 * accumulates `cost_entries.cost_usd` values, so it inherits their type and
 * their caveats. It is a spend ESTIMATE used to stop routing to an exhausted
 * key, never an amount charged to anybody.
 *
 * The eight `rate_limit_*` columns are the flattened `rateLimit` sub-document.
 * All eight are nullable and nullable means UNLIMITED, not zero — a zero would
 * read as "no requests permitted", which is the opposite.
 */
export const providerKeys = pgTable(
  'provider_keys',
  {
    id: generatedId(),
    name: text().notNull(),
    provider: text({ enum: PROVIDER_NAMES as unknown as [string, ...string[]] }).notNull(),
    environment: text({ enum: PROVIDER_KEY_ENVIRONMENTS as unknown as [string, ...string[]] })
      .notNull()
      .default('production'),

    /** sha256 of the credential. Protected: an exact-match oracle over it. */
    keyHash: text().notNull(),
    /** The first few characters, for display. The one identifier safe to log. */
    keyPrefix: text().notNull(),
    /** PLAINTEXT credential — see the table comment before reading this column. */
    key: text(),

    rateLimitRps: integer(),
    rateLimitRpm: integer(),
    rateLimitRph: integer(),
    rateLimitRpd: integer(),
    rateLimitTps: integer(),
    rateLimitTpm: integer(),
    rateLimitTph: integer(),
    rateLimitTpd: integer(),

    isActive: boolean().notNull().default(true),
    isPaid: boolean().notNull().default(false),
    tier: text({ enum: PROVIDER_KEY_TIERS as unknown as [string, ...string[]] })
      .notNull()
      .default('free'),

    /**
     * Dynamic priority. `recordFailure` moves a key to the back of the queue by
     * setting this to one past the current maximum, and `recordSuccess` restores
     * it from `original_priority`. The two ranges differ (1..1000 against
     * 1..100) precisely because this one absorbs that displacement.
     */
    currentPriority: integer().notNull().default(10),
    originalPriority: integer().notNull().default(10),

    /** Null means UNLIMITED spend, not zero. */
    creditLimitUsd: doublePrecision('credit_limit_usd'),
    spentUsd: doublePrecision('spent_usd').notNull().default(0),

    lastUsedAt: timestamptz(),
    lastSuccessAt: timestamptz(),
    totalRequests: integer().notNull().default(0),
    totalTokens: integer().notNull().default(0),
    successCount: integer().notNull().default(0),

    consecutiveFailures: integer().notNull().default(0),
    totalFailures: integer().notNull().default(0),
    lastFailureAt: timestamptz(),
    lastFailureReason: text(),
    cooldownUntil: timestamptz(),
    rateLimitResetMs: integer(),

    maxTotalFailures: integer().notNull().default(100),
    isArchived: boolean().notNull().default(false),
    archivedAt: timestamptz(),
    archivedReason: text(),

    rotatedAt: timestamptz(),
    expiresAt: timestamptz(),
    rotationSchedule: text({ enum: PROVIDER_KEY_ROTATION_SCHEDULES as unknown as [string, ...string[]] })
      .notNull()
      .default('manual'),

    /** An Oxy account. No foreign key: Oxy owns identity. */
    ownerId: text(),
    /**
     * The owning organization, and the orgs/dev batch settled what its deletion
     * does: **cascade**.
     *
     * The column is currently INERT — declared and indexed in Mongoose, never
     * written and never filtered on, verified package-wide rather than within the
     * providers directory. So the constraint costs nothing today and exists to
     * close the dangerous direction before multi-tenancy is built on it.
     *
     * `ON DELETE SET NULL` is the option to avoid, and it is the tempting one
     * because the column is nullable. `key-manager.ts` selects keys by PROVIDER
     * and does not filter by organization at all, so nulling this would silently
     * promote a deleted organization's private credential into the pool every
     * other tenant draws from. Deleting the row with the organization is the safe
     * direction and matches what the field means.
     */
    organizationId: text().references(() => organizations.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('provider_keys_key_hash_key').on(t.keyHash),
    index('provider_keys_rotation_idx').on(t.provider, t.isActive, t.isArchived, t.currentPriority),
    index('provider_keys_environment_active_idx').on(t.environment, t.isActive),
    /**
     * Partial, the direct equivalent of Mongo's `sparse: true`. A plain index
     * would carry a row per key for a column almost every key leaves null.
     */
    index('provider_keys_owner_id_idx').on(t.ownerId).where(sql`${t.ownerId} is not null`),
    index('provider_keys_organization_id_idx')
      .on(t.organizationId)
      .where(sql`${t.organizationId} is not null`),
    checkOneOf('provider_keys_provider_check', t.provider, PROVIDER_NAMES),
    checkOneOf('provider_keys_environment_check', t.environment, PROVIDER_KEY_ENVIRONMENTS),
    checkOneOf('provider_keys_tier_check', t.tier, PROVIDER_KEY_TIERS),
    checkOneOf('provider_keys_rotation_schedule_check', t.rotationSchedule, PROVIDER_KEY_ROTATION_SCHEDULES),
    check('provider_keys_current_priority_range_check', sql`${t.currentPriority} between 1 and 1000`),
    check('provider_keys_original_priority_range_check', sql`${t.originalPriority} between 1 and 100`),
    check('provider_keys_spent_usd_check', sql`${t.spentUsd} >= 0`),
    check('provider_keys_max_total_failures_range_check', sql`${t.maxTotalFailures} between 10 and 1000`),
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
