/**
 * Provider circuit-breaker state, on Postgres.
 *
 * One row per `(provider, model_id)`. Every request outcome moves counters on
 * that row and the circuit breaker's next state is derived from the counters as
 * they stand AFTER the move.
 *
 * ## The recording path is ONE statement, and that is a behaviour change
 *
 * The Mongo version did it in two writes: a `findOneAndUpdate` applying the
 * `$inc` atomically, then a second `updateOne` writing back a circuit state that
 * JavaScript had derived from the returned document. Between those two writes
 * another request could open, close or half-open the same circuit, and the
 * second write would overwrite it with a decision made from a snapshot — a lost
 * update on the one field the table exists to hold.
 *
 * Postgres can express the whole thing as a single `INSERT … ON CONFLICT DO
 * UPDATE`, because inside the `DO UPDATE` the table's own name refers to the
 * row's PRE-UPDATE values, which is exactly the `prevState` the derivation
 * needs. So the counters and the state they imply are written together, under
 * the row lock the upsert already takes, and no window exists.
 *
 * The transition RULES are unchanged and are asserted case by case in
 * `db/__tests__/providerHealthRepository.pgdb.test.ts`. What changed is that two
 * concurrent recordings can no longer interleave into a state neither of them
 * computed. Flagged rather than absorbed: the outcome for a single caller is
 * identical, and under concurrency it differs by being correct.
 *
 * ## `prev` is a CTE, not a second round trip
 *
 * The caller invalidates its in-memory cache only when routing-relevant state
 * actually moved, so it needs the before AND after values. `RETURNING` yields
 * only the new row, so the previous one is read in a CTE alongside the upsert:
 * CTEs see the snapshot taken at statement start, so `prev` is the pre-update
 * row even though it is part of the statement that updates it.
 *
 * ## Ids are generated here
 *
 * `generatedId()` is a JS-side default that drizzle's query builder applies. A
 * raw `sql` INSERT bypasses it — the column has no database `DEFAULT` — so every
 * statement below passes `uuidv7()` explicitly. Omitting it fails loudly on a
 * `NOT NULL`, which is the one good property of this trap.
 */

import { desc, eq, and, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { ApiDatabase } from '../index';
import { providerHealth, type CircuitState } from '../schema/telemetry';

/**
 * Circuit breaker thresholds.
 *
 * Interpolated into SQL as bound parameters, never as raw text — a threshold
 * that reached a generated migration or a CHECK as a literal `$1` is a known
 * failure in this estate, and although these only ever appear in DML the habit
 * is cheaper to keep than to remember when to drop.
 *
 * ## Every comparison against one of these carries an explicit cast
 *
 * `$a >= $b` with a parameter on BOTH sides gives Postgres nothing to infer
 * from, and it resolves the operator as `text >= text` — under which `'7'` is
 * greater than `'10'`, so a circuit trips at the wrong count with no error
 * anywhere. Today the left-hand side of each of these is a column expression, so
 * the integer operator is chosen and the casts are redundant. They are here
 * because that property is invisible: it is a fact about the OTHER operand, and
 * a refactor replacing a column expression with a computed value would silently
 * flip every threshold in this file to a lexicographic comparison. Measured, not
 * theorised — a mutation that made those operands parameters turned the
 * ten-request health threshold into a string compare and nothing raised.
 */
export const CIRCUIT_CONFIG = {
  /** Open the circuit after this many consecutive real failures. */
  failureThreshold: 5,
  /** Close it after this many consecutive successes while half-open. */
  successThreshold: 2,
  /** How long a circuit stays open before a probe is allowed. */
  openDurationMs: 60_000,
  halfOpenMaxAttempts: 3,
  /** Below this many requests the success rate is not meaningful. */
  minRequestsForMetrics: 10,
  /** Percent. At or above this the provider counts as healthy. */
  unhealthySuccessRateThreshold: 50,
} as const;

/**
 * A row as selected, inferred from the table rather than restated.
 *
 * A hand-written interface here would be a second definition of the same shape
 * with nothing keeping the two aligned — and it silently omitted `id`, which
 * `tsc` caught only because a test happened to read the column the type claimed
 * did not exist. Inference cannot drift.
 */
export type ProviderHealthRow = typeof providerHealth.$inferSelect;

/**
 * What a recording changed, so the caller can decide whether its cache is stale.
 *
 * `prev*` is null when the row did not exist — a first-ever recording, where
 * there is nothing cached to invalidate and comparing against null harmlessly
 * reads as "changed".
 */
export interface CircuitTransition {
  readonly prevState: CircuitState | null;
  readonly prevHealthy: boolean | null;
  readonly nextState: CircuitState;
  readonly nextHealthy: boolean;
}

interface TransitionRow extends Record<string, unknown> {
  prev_state: CircuitState | null;
  prev_healthy: boolean | null;
  next_state: CircuitState;
  next_healthy: boolean;
}

/**
 * The rolling window of latency samples with `latencyMs` appended, capped at the
 * most recent 100 — Mongo's `$push … $slice: -100`.
 *
 * `cardinality(samples) - 98` is the start index because the appended array is
 * one longer than the stored one: keeping its last 100 means starting at
 * `n + 1 - 99`. `greatest(1, …)` covers every array shorter than the cap, and an
 * open upper bound keeps the tail without naming its length twice.
 */
const cappedSamples = (latencyMs: number) => sql`
  (${providerHealth.latencySamples} || ${latencyMs}::double precision)[
    greatest(1, cardinality(${providerHealth.latencySamples}) - 98):
  ]`;

/** Read one row, or null. Internal: every caller outside wants get-or-create. */
async function findProviderHealth(
  db: ApiDatabase,
  provider: string,
  modelId: string,
): Promise<ProviderHealthRow | null> {
  const [row] = await db
    .select()
    .from(providerHealth)
    .where(and(eq(providerHealth.provider, provider), eq(providerHealth.modelId, modelId)));
  return row ?? null;
}

/**
 * Read one row, creating it in its default state if absent.
 *
 * `DO UPDATE SET provider = excluded.provider` rather than `DO NOTHING`: the
 * latter returns no row on conflict, which would need a second read on the path
 * two callers race. Writing the column back to the value it already holds is a
 * no-op that still makes `RETURNING` fire.
 *
 * `excluded.provider` is spelled out as text. Interpolating the column object
 * would emit drizzle's JS property name, which for a camelCase column produces
 * `excluded.modelid` and a `42703` at runtime; `provider` happens to survive
 * that, and writing it by hand means the next column added here does too.
 */
export async function getOrCreateProviderHealth(
  db: ApiDatabase,
  provider: string,
  modelId: string,
  now: Date,
): Promise<ProviderHealthRow> {
  const existing = await findProviderHealth(db, provider, modelId);
  if (existing) return existing;

  const [created] = await db
    .insert(providerHealth)
    .values({ provider, modelId, lastHealthCheck: now })
    .onConflictDoUpdate({
      target: [providerHealth.provider, providerHealth.modelId],
      set: { provider: sql`excluded.provider` },
    })
    .returning();
  return created;
}

/**
 * Record a successful request and derive the circuit's next state from the
 * freshly-incremented counters.
 *
 * On INSERT the values are what the Mongo upsert's `$inc` plus its follow-up
 * write produced for a brand-new row: one success out of one request, so a
 * success rate of 100 and the single sample as the mean.
 */
export async function recordProviderSuccess(
  db: ApiDatabase,
  provider: string,
  modelId: string,
  latencyMs: number,
  now: Date,
): Promise<CircuitTransition> {
  const nowIso = now.toISOString();
  const samples = cappedSamples(latencyMs);
  const nextSuccesses = sql`(${providerHealth.successCount} + 1)`;
  const nextTotal = sql`(${providerHealth.totalRequests} + 1)`;
  const nextConsecutiveSuccesses = sql`(${providerHealth.consecutiveSuccesses} + 1)`;
  const nextRate = sql`(${nextSuccesses}::double precision / ${nextTotal} * 100)`;
  /** True exactly when a half-open circuit has earned its way back to closed. */
  const closes = sql`(${providerHealth.circuitState} = 'half-open'
    and ${nextConsecutiveSuccesses} >= ${CIRCUIT_CONFIG.successThreshold}::int)`;

  const rows = await db.execute<TransitionRow>(sql`
    with prev as (
      select ${providerHealth.circuitState} as prev_state, ${providerHealth.isHealthy} as prev_healthy
      from ${providerHealth}
      where ${providerHealth.provider} = ${provider} and ${providerHealth.modelId} = ${modelId}
    ),
    upserted as (
      insert into ${providerHealth} (
        id, provider, model_id, success_count, total_requests, consecutive_successes,
        consecutive_failures, success_rate, average_latency_ms, latency_samples,
        last_success, last_health_check
      )
      values (
        ${uuidv7()}, ${provider}, ${modelId}, 1, 1, 1,
        0, 100, ${latencyMs}, array[${latencyMs}]::double precision[],
        ${nowIso}::timestamptz, ${nowIso}::timestamptz
      )
      on conflict (provider, model_id) do update set
        success_count = ${nextSuccesses},
        total_requests = ${nextTotal},
        consecutive_successes = ${nextConsecutiveSuccesses},
        consecutive_failures = 0,
        last_success = ${nowIso}::timestamptz,
        last_health_check = ${nowIso}::timestamptz,
        latency_samples = ${samples},
        average_latency_ms = (select avg(sample) from unnest(${samples}) as sample),
        success_rate = ${nextRate},
        circuit_state = case when ${closes} then 'closed' else ${providerHealth.circuitState} end,
        circuit_opened_at = case when ${closes} then null else ${providerHealth.circuitOpenedAt} end,
        half_open_attempts = case
          when ${closes} then 0
          when ${providerHealth.circuitState} = 'half-open' then ${providerHealth.halfOpenAttempts} + 1
          else ${providerHealth.halfOpenAttempts}
        end,
        -- Order matters and mirrors the source: the half-open close sets healthy,
        -- and a meaningful sample size then overrides it either way.
        is_healthy = case
          when ${nextTotal} >= ${CIRCUIT_CONFIG.minRequestsForMetrics}::int
            then ${nextRate} >= ${CIRCUIT_CONFIG.unhealthySuccessRateThreshold}::double precision
          when ${closes} then true
          else ${providerHealth.isHealthy}
        end,
        updated_at = date_trunc('milliseconds', now())
      returning ${providerHealth.circuitState} as next_state, ${providerHealth.isHealthy} as next_healthy
    )
    select upserted.next_state, upserted.next_healthy, prev.prev_state, prev.prev_healthy
    from upserted left join prev on true
  `);
  return toTransition(rows[0]);
}

/**
 * Record a failed request.
 *
 * A rate limit is transient — the provider is working and the quota is not — so
 * it moves the failure and request counters but neither consecutive counter, and
 * therefore can never open the circuit on its own. That conditionality is why
 * the two increments are interpolated rather than written literally.
 */
export async function recordProviderFailure(
  db: ApiDatabase,
  provider: string,
  modelId: string,
  now: Date,
  isRateLimit: boolean,
): Promise<CircuitTransition> {
  const nowIso = now.toISOString();
  const nextTotal = sql`(${providerHealth.totalRequests} + 1)`;
  const nextConsecutiveFailures = isRateLimit
    ? sql`${providerHealth.consecutiveFailures}`
    : sql`(${providerHealth.consecutiveFailures} + 1)`;
  const nextConsecutiveSuccesses = isRateLimit ? sql`${providerHealth.consecutiveSuccesses}` : sql`0`;
  /** `success_count` does not move on a failure, so only the denominator does. */
  const nextRate = sql`(${providerHealth.successCount}::double precision / ${nextTotal} * 100)`;
  const opensFromClosed = sql`(${providerHealth.circuitState} = 'closed'
    and ${nextConsecutiveFailures} >= ${CIRCUIT_CONFIG.failureThreshold}::int)`;
  const reopensFromHalfOpen = sql`(${providerHealth.circuitState} = 'half-open')`;
  const opens = sql`(${opensFromClosed} or ${reopensFromHalfOpen})`;

  const rows = await db.execute<TransitionRow>(sql`
    with prev as (
      select ${providerHealth.circuitState} as prev_state, ${providerHealth.isHealthy} as prev_healthy
      from ${providerHealth}
      where ${providerHealth.provider} = ${provider} and ${providerHealth.modelId} = ${modelId}
    ),
    upserted as (
      insert into ${providerHealth} (
        id, provider, model_id, failure_count, total_requests, consecutive_failures,
        success_rate, last_failure, last_health_check
      )
      values (
        ${uuidv7()}, ${provider}, ${modelId}, 1, 1, ${isRateLimit ? 0 : 1},
        0, ${nowIso}::timestamptz, ${nowIso}::timestamptz
      )
      on conflict (provider, model_id) do update set
        failure_count = ${providerHealth.failureCount} + 1,
        total_requests = ${nextTotal},
        consecutive_failures = ${nextConsecutiveFailures},
        consecutive_successes = ${nextConsecutiveSuccesses},
        last_failure = ${nowIso}::timestamptz,
        last_health_check = ${nowIso}::timestamptz,
        success_rate = ${nextRate},
        circuit_state = case when ${opens} then 'open' else ${providerHealth.circuitState} end,
        circuit_opened_at = case when ${opens} then ${nowIso}::timestamptz else ${providerHealth.circuitOpenedAt} end,
        half_open_attempts = case when ${reopensFromHalfOpen} then 0 else ${providerHealth.halfOpenAttempts} end,
        is_healthy = case
          when ${nextTotal} >= ${CIRCUIT_CONFIG.minRequestsForMetrics}::int
            then ${nextRate} >= ${CIRCUIT_CONFIG.unhealthySuccessRateThreshold}::double precision
          when ${opens} then false
          else ${providerHealth.isHealthy}
        end,
        updated_at = date_trunc('milliseconds', now())
      returning ${providerHealth.circuitState} as next_state, ${providerHealth.isHealthy} as next_healthy
    )
    select upserted.next_state, upserted.next_healthy, prev.prev_state, prev.prev_healthy
    from upserted left join prev on true
  `);
  return toTransition(rows[0]);
}

function toTransition(row: TransitionRow | undefined): CircuitTransition {
  if (!row) {
    // Unreachable: the upsert always yields exactly one row, and the left join
    // cannot drop it. Throwing rather than fabricating a transition keeps a
    // broken statement from reading as "nothing changed".
    throw new Error('provider health upsert returned no row');
  }
  return {
    prevState: row.prev_state,
    prevHealthy: row.prev_healthy,
    nextState: row.next_state,
    nextHealthy: row.next_healthy,
  };
}

/**
 * Move a specific circuit from open to half-open so one probe can through.
 *
 * Guarded on the state it is leaving, so two callers racing produce one
 * transition rather than resetting `consecutive_successes` twice. The count of
 * updated rows is returned because "already half-open" and "moved it" are
 * different answers and only the caller knows whether it cares.
 */
export async function openCircuitForProbe(
  db: ApiDatabase,
  provider: string,
  modelId: string,
): Promise<number> {
  const result = await db
    .update(providerHealth)
    .set({ circuitState: 'half-open', halfOpenAttempts: 0, consecutiveSuccesses: 0 })
    .where(
      and(
        eq(providerHealth.provider, provider),
        eq(providerHealth.modelId, modelId),
        eq(providerHealth.circuitState, 'open'),
      ),
    );
  return result.count;
}

/**
 * Every circuit that has been open longer than the cooldown, moved to half-open
 * in one statement.
 *
 * The Mongo version read all open and half-open rows and looped, testing the
 * cooldown in JavaScript and saving each document. The predicate is the same one
 * — `circuit_state = 'open'` and a `circuit_opened_at` older than the cooldown —
 * expressed where the rows are, so nothing is fetched to be discarded and no row
 * can change between the read and the save.
 *
 * Note this path measures the cooldown from `circuit_opened_at` while
 * `isProviderAvailable` measures it from `last_failure`. That divergence is the
 * source's and is preserved deliberately: they are two different questions
 * ("has it been open long enough" vs "has it been quiet long enough") and
 * unifying them would change routing behaviour, which is not this port's call.
 */
export async function halfOpenExpiredCircuits(db: ApiDatabase, now: Date): Promise<number> {
  const cutoffIso = new Date(now.getTime() - CIRCUIT_CONFIG.openDurationMs).toISOString();
  const result = await db
    .update(providerHealth)
    .set({ circuitState: 'half-open', halfOpenAttempts: 0 })
    .where(
      and(
        eq(providerHealth.circuitState, 'open'),
        sql`${providerHealth.circuitOpenedAt} is not null`,
        sql`${providerHealth.circuitOpenedAt} <= ${cutoffIso}::timestamptz`,
      ),
    );
  return result.count;
}

/** Every row, newest activity first — the monitoring dashboard's read. */
export async function listProviderHealth(db: ApiDatabase): Promise<ProviderHealthRow[]> {
  return db.select().from(providerHealth).orderBy(desc(providerHealth.updatedAt));
}

/**
 * Return one provider/model to its default state, creating the row if absent.
 *
 * `latency_samples` is deliberately NOT cleared, matching the source: the reset
 * is an operator action against a stuck circuit, and the latency window is
 * observation rather than circuit state.
 */
export async function resetProviderHealth(
  db: ApiDatabase,
  provider: string,
  modelId: string,
  now: Date,
): Promise<void> {
  const defaults = {
    successCount: 0,
    failureCount: 0,
    totalRequests: 0,
    successRate: 100,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    circuitState: 'closed' as const,
    circuitOpenedAt: null,
    halfOpenAttempts: 0,
    isHealthy: true,
    lastHealthCheck: now,
  };
  await db
    .insert(providerHealth)
    .values({ provider, modelId, ...defaults })
    .onConflictDoUpdate({
      target: [providerHealth.provider, providerHealth.modelId],
      set: { ...defaults, updatedAt: sql`date_trunc('milliseconds', now())` },
    });
}

/**
 * Close every circuit that is currently open or half-open, leaving the traffic
 * counters alone.
 *
 * ## Why the returned count is `rowCount` and that is not a shortcut
 *
 * Mongo reported `modifiedCount`, which excludes matched rows the `$set` left
 * unchanged; Postgres reports only a row count, which behaves like
 * `matchedCount`. Substituting one for the other is wrong in general. It is
 * right HERE, and for a reason that has to be checked rather than assumed: the
 * filter selects only rows whose `circuit_state` is NOT `closed` and the update
 * sets it to `closed`, so every matched row necessarily changes. `last_health_check`
 * moving to `now` on every row makes it doubly true. The two counts cannot
 * diverge for this statement.
 *
 * ## Reached only through the model registry
 *
 * Its caller looked the model up as `mongoose.models.ProviderHealth` with no
 * import at all, which is why no import-based census of this port could see it.
 */
export async function closeAllCircuits(db: ApiDatabase, now: Date): Promise<number> {
  const result = await db
    .update(providerHealth)
    .set({
      circuitState: 'closed',
      circuitOpenedAt: null,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      halfOpenAttempts: 0,
      isHealthy: true,
      lastHealthCheck: now,
    })
    .where(sql`${providerHealth.circuitState} in ('open', 'half-open')`);
  return result.count;
}

/**
 * Return EVERY row to its default state — counters included.
 *
 * Distinct from {@link closeAllCircuits}, which the neighbouring registry call
 * site uses: that one is filtered to non-closed circuits and preserves the
 * traffic counters, this one is unfiltered and zeroes them. The two were one
 * line apart in the census and are not interchangeable — collapsing them would
 * silently erase every provider's success history whenever a deploy reset stale
 * circuit breakers.
 *
 * The count is again `rowCount` standing in for `modifiedCount`, sound for the
 * same checked reason: `last_health_check` is set to `now` on every matched row,
 * so no matched row can come back unmodified.
 */
export async function resetAllProviderHealth(db: ApiDatabase, now: Date): Promise<number> {
  const result = await db.update(providerHealth).set({
    successCount: 0,
    failureCount: 0,
    totalRequests: 0,
    successRate: 100,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    circuitState: 'closed',
    circuitOpenedAt: null,
    halfOpenAttempts: 0,
    isHealthy: true,
    lastHealthCheck: now,
  });
  return result.count;
}
