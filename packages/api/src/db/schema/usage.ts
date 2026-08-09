/**
 * What a completion cost, and what it did.
 *
 * `cost_entries` is the per-request spend ledger; `chat_analytics` is the
 * per-request usage record. They stay separate tables because they are written
 * by different subsystems for different reasons, and merging them would couple a
 * billing figure to an analytics hook.
 *
 * Neither carried a TTL index, so neither appears in `db/expiryTargets.ts`.
 * `cost_entries` in particular is spend history and must NOT acquire one by
 * analogy with its neighbours in this schema.
 */

import { boolean, doublePrecision, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxyhq/db';

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
