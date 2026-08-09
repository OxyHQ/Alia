/**
 * The response cache and its running totals.
 *
 * Two tables from one Mongoose file, and they are shaped very differently on
 * purpose: `cache_entries` is many rows with a deadline, `cache_stats` is ONE
 * row of counters.
 */

import { bigint, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { checkOneOf } from './columns';

/**
 * One cached model response.
 *
 * TTL: `expireAfterSeconds: 0` on `expires_at` — the column IS the deadline, so
 * the registry entry is `retentionSeconds: 0` rather than a duration measured
 * from a birth column. Getting those two forms the wrong way round deletes
 * everything, which is why the coverage gate compares the source column too.
 *
 * `messages` and `response` are `jsonb`. They were `Schema.Types.Mixed` and are
 * genuinely shapeless — a provider's message array and its completion, stored
 * whole, read whole, never queried into. This is the same argument that gives
 * `fallback_events.attempts` its jsonb: the format belongs to somebody else.
 *
 * `key` is UNIQUE, which is what makes the cache a cache. Note the Mongoose
 * field carried both `unique: true` and `index: true`, which creates ONE index;
 * the port keeps one.
 */
export const cacheEntries = pgTable(
  'cache_entries',
  {
    id: generatedId(),
    key: text().notNull(),
    promptHash: text().notNull(),
    model: text().notNull(),
    messages: jsonb().notNull(),
    response: jsonb().notNull(),
    tokensUsed: integer().notNull().default(0),
    /** USD. `double precision`, not money in minor units — see cost_entries. */
    costSaved: doublePrecision().notNull().default(0),
    hitCount: integer().notNull().default(0),
    /** The deadline itself, not a birth timestamp. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('cache_entries_key_key').on(t.key),
    index('cache_entries_prompt_hash_idx').on(t.promptHash),
    index('cache_entries_model_idx').on(t.model),
    index('cache_entries_expires_at_idx').on(t.expiresAt),
    index('cache_entries_created_at_idx').on(t.createdAt),
  ],
);

/**
 * Lifetime cache totals — exactly one row.
 *
 * Mongo gave it `_id: 'global'` with a default, so the singleton was enforced by
 * everybody agreeing to use the same id. Here `id` keeps that literal value and
 * the CHECK makes it structural: a second row is unrepresentable rather than
 * merely unusual, so a stray insert cannot silently split the counters in two
 * and leave every read showing whichever half it found.
 *
 * The counters are `bigint` because they only ever grow and a service that
 * serves millions of completions will pass 2^31. `mode: 'number'` re-imposes the
 * JS safe-integer ceiling, which is the right trade here — these are counts, not
 * identifiers, and `Number.MAX_SAFE_INTEGER` is nine quadrillion.
 *
 * **Read them with `Number(...)` at the boundary.** postgres.js decodes `int8`
 * as a STRING, and drizzle types it as `number`, so `total + 1` type-checks
 * clean and is string concatenation. A test that increments ONCE cannot catch
 * that — the second increment is the first one with something to concatenate
 * onto.
 */
export const CACHE_STATS_SINGLETON_ID = 'global';

export const cacheStats = pgTable(
  'cache_stats',
  {
    id: text().primaryKey().default(CACHE_STATS_SINGLETON_ID),
    totalHits: bigint({ mode: 'number' }).notNull().default(0),
    totalMisses: bigint({ mode: 'number' }).notNull().default(0),
    totalCostSaved: doublePrecision().notNull().default(0),
    totalTokensSaved: bigint({ mode: 'number' }).notNull().default(0),
    lastReset: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [checkOneOf('cache_stats_singleton_check', t.id, [CACHE_STATS_SINGLETON_ID])],
);
