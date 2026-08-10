/**
 * What a request cost, and what it did.
 *
 * `cost_entries` is the per-request spend ledger; `chat_analytics` is the
 * per-request usage record. They stay separate tables because they are written
 * by different subsystems for different reasons, and merging them would couple a
 * billing figure to an analytics hook.
 *
 * `voice_call_usage` is the same pair of concerns for a REALTIME VOICE session
 * rather than a completion — it is both the usage record and the billing figure,
 * because a voice call is charged by elapsed minutes rather than by tokens, so
 * there is no second subsystem to separate it from.
 *
 * None of the three carried a TTL index, so none appears in
 * `db/expiryTargets.ts`. `cost_entries` and `voice_call_usage` in particular are
 * spend history and must NOT acquire one by analogy with the short-lived tables
 * elsewhere in this schema.
 */

import { boolean, doublePrecision, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';

/**
 * One request's cost, in USD.
 *
 * **`cost_usd` is `double precision`, deliberately, and this is the one place in
 * the schema where that needs defending.** Oxy's convention for money is
 * `bigint` minor units, because a price is an exact amount somebody is charged
 * and binary floating point cannot represent it. This is not that: it is a
 * derived estimate — tokens multiplied by a published per-token rate that is
 * itself a fraction of a cent — and no minor unit exists to hold it. Rounding it
 * to cents at write time would destroy the per-request figure entirely, since a
 * single completion routinely costs less than one cent.
 *
 * Two consequences that follow, and must not be forgotten when somebody reports
 * a total looking wrong: sums of many rows accumulate float error, and equality
 * comparison on this column is meaningless. Aggregate with `sum()` for display
 * and never compare a total for exactness. If per-user BILLING is ever taken
 * from this table rather than from a payment provider's own figures, that is the
 * moment to reconsider the type — not before.
 *
 * `user_id` is an Oxy account, so no foreign key.
 */
export const costEntries = pgTable(
  'cost_entries',
  {
    id: generatedId(),
    userId: text().notNull(),
    sessionId: text(),
    aliasModelId: text().notNull(),
    /**
     * The real provider and model behind the Alia-branded alias. This is
     * INTERNAL: it must never reach a user-facing response, an error message or
     * a public API surface — the whole point of the alias is that a caller sees
     * `alia-v1`, not whoever served it.
     */
    actualProvider: text().notNull(),
    actualModelId: text().notNull(),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    totalTokens: integer().notNull(),
    costUsd: doublePrecision().notNull(),
    savedFromCache: boolean().notNull().default(false),
    timestamp: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('cost_entries_user_timestamp_idx').on(t.userId, t.timestamp.desc()),
    index('cost_entries_alias_model_timestamp_idx').on(t.aliasModelId, t.timestamp.desc()),
    index('cost_entries_user_alias_model_idx').on(t.userId, t.aliasModelId),
    index('cost_entries_session_id_idx').on(t.sessionId),
  ],
);

/**
 * One completion's usage, recorded by the analytics hook.
 *
 * `oxy_user_id` was declared `ref: 'User'` in Mongoose — a join to a model this
 * service does not register. It is a plain Oxy account id here with no foreign
 * key, per `lib/oxy-user-hydration.ts`.
 *
 * `platform` has no CHECK. Its Mongoose field is a bare `String` defaulting to
 * `'app'` with no enum, so production may hold anything a client sent, and a
 * CHECK would fail on the first unexpected value — in a hook that runs on every
 * completion. Same reasoning as `auth_health_metrics.method`; revisit after the
 * backfill audits the actual values.
 */
export const chatAnalytics = pgTable(
  'chat_analytics',
  {
    id: generatedId(),
    oxyUserId: text().notNull(),
    model: text().notNull(),
    provider: text().notNull(),
    promptTokens: integer().notNull().default(0),
    completionTokens: integer().notNull().default(0),
    totalTokens: integer().notNull().default(0),
    latencyMs: integer().notNull().default(0),
    platform: text().notNull().default('app'),
    createdAt: createdAt(),
  },
  (t) => [index('chat_analytics_oxy_user_created_at_idx').on(t.oxyUserId, t.createdAt.desc())],
);

/**
 * One realtime voice session: how long it ran and what it charged.
 *
 * ## The number types are three different things, and the split is not cosmetic
 *
 * - **Durations are `double precision`.** `voice-session-manager.ts:1228`
 *   computes `(endTime - startTime) / 60000`, so a two-and-a-half minute call
 *   stores `2.5`. An `integer` would silently truncate every call to a whole
 *   minute, and it is the BILLING quantity.
 * - **`cost_per_minute` is `double precision`.** A published per-minute rate, a
 *   fraction of a cent — `cost_entries.cost_usd`'s reasoning exactly, and not
 *   the `bigint` minor-unit convention, which applies to an amount somebody is
 *   charged rather than to a rate.
 * - **Credits are `integer`.** A count, per CONVENTIONS.md.
 *
 * **The aggregate trap lands on the durations, and they are the safe side of it
 * by luck rather than by design.** `lib/voice-usage.ts:41` sums
 * `duration_minutes + cohost_duration_minutes` to enforce a plan's voice-minute
 * entitlement. `sum(double precision)` returns `double precision`, which
 * postgres.js decodes as a JS number — so that reader ports cleanly. The same
 * sum over `credits_charged` would NOT: `sum(integer)` returns `bigint`, which
 * decodes as a STRING, and `total + 1` becomes string concatenation. Nothing
 * sums credits today. Whoever adds the obvious "credits spent this period"
 * figure has to coerce at that boundary, and a test that aggregates ONE row
 * cannot tell the two apart.
 *
 * ## `provider` gets no CHECK, though `PROVIDER_NAMES` exists
 *
 * That tuple renders CHECKs on three columns in `providers.ts`. Not here: this
 * Mongoose field is a bare `String` with no `enum`, so production may already
 * hold anything the voice manager wrote, and a CHECK would fail on the first
 * unexpected value in the session-teardown path — where the alternative to
 * writing the row is losing the billing record for a call that already
 * happened. `auth_health_metrics.method` and `chat_analytics.platform` are the
 * same call. `audio_format`, `disconnect_reason` and `client_type` are bare
 * strings for the same reason. Revisit after the backfill audits the values.
 *
 * ## Two columns are declared and never written
 *
 * `average_latency_ms` and `client_type` are in the Mongoose schema and appear
 * in no write anywhere in the package — verified whole-package, not just around
 * the writer. They are ported so the shape is faithful, and they are the
 * `provider_keys.organization_id` case: confirm they are entirely absent before
 * anybody reads one as meaningful.
 *
 * `session_id` is the provider's own session identifier and is UNIQUE, which is
 * load-bearing rather than decorative: `voice-session-manager.ts:1258` upserts
 * the final record on it, and `:1260` plainly inserts the non-final one, so the
 * unique is what stops a session accumulating duplicate rows. It is NOT a
 * primary key — CONVENTIONS.md keeps Mongo's `_id`.
 *
 * `oxy_user_id` is a plain Oxy account id: no foreign key, and unlike its
 * neighbours in this file it was declared a bare `String` in Mongoose rather
 * than `ref: 'User'`, so nothing ever tried to populate it.
 */
export const voiceCallUsage = pgTable(
  'voice_call_usage',
  {
    id: generatedId(),
    sessionId: text().notNull(),
    oxyUserId: text().notNull(),
    aliaModelId: text().notNull(),
    /** No CHECK, deliberately — see the table comment. */
    provider: text().notNull(),
    providerModel: text().notNull(),

    startTime: timestamptz().notNull(),
    /** Absent while the session is still running. */
    endTime: timestamptz(),
    /** Fractional minutes. See the table comment. */
    durationMinutes: doublePrecision().notNull().default(0),

    creditsCharged: integer().notNull().default(0),
    /**
     * `required` in Mongoose with no default. A `required` binds only writes
     * made after it was added, so a session predating it may have none —
     * a backfill audit item, listed in CONVENTIONS.md.
     */
    costPerMinute: doublePrecision().notNull(),

    /** Declared, never written. See the table comment. */
    averageLatencyMs: doublePrecision(),
    disconnectReason: text(),

    audioFormat: text().notNull().default('pcm16'),
    sampleRate: integer().notNull().default(24000),
    /** Declared, never written. See the table comment. */
    clientType: text(),

    cohostEnabled: boolean().notNull().default(false),
    cohostProvider: text(),
    cohostProviderModel: text(),
    cohostDurationMinutes: doublePrecision().notNull().default(0),
    cohostCreditsCharged: integer().notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('voice_call_usage_session_id_key').on(t.sessionId),
    // Serves the entitlement check in `lib/voice-usage.ts`.
    index('voice_call_usage_oxy_user_start_time_idx').on(t.oxyUserId, t.startTime.desc()),
    index('voice_call_usage_provider_start_time_idx').on(t.provider, t.startTime.desc()),
    index('voice_call_usage_alia_model_start_time_idx').on(t.aliaModelId, t.startTime.desc()),
    // Mongoose also declared single-field indexes on `oxyUserId`, `aliaModelId`
    // and `provider`; each is the PREFIX of a compound above, so the compound
    // serves it and a separate index would only cost writes. Its fourth,
    // `startTime` alone, has no reader in this package — every query that
    // filters on time also filters on one of the three leading columns.
  ],
);
