import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, type ApiDatabase } from '../index';
import {
  CIRCUIT_CONFIG,
  closeAllCircuits,
  getOrCreateProviderHealth,
  halfOpenExpiredCircuits,
  listProviderHealth,
  openCircuitForProbe,
  recordProviderFailure,
  recordProviderSuccess,
  resetAllProviderHealth,
  resetProviderHealth,
} from '../telemetry/providerHealthRepository';
import { providerHealth } from '../schema/telemetry';

/**
 * `provider_health`, against a real server.
 *
 * This table holds a CIRCUIT BREAKER, so the failure that matters is not an
 * exception — it is a transition that quietly does not happen, or happens to a
 * row the caller did not mean. A breaker that never opens and a provider that
 * never fails produce the same table, so every case below asserts the state that
 * must NOT be reached as well as the one that must.
 *
 * Providers are namespaced per test. The pgdb suite shares ONE database across
 * files and `(provider, model_id)` is a unique key.
 *
 * Two functions here are UNFILTERED — `closeAllCircuits` and
 * `resetAllProviderHealth` write every row in the table. They are exercised last
 * and their assertions are scoped to rows this file created, because scoping the
 * WRITE is not something the production callers do either: both are deliberate
 * operator hammers. No other pgdb file touches this table; if one ever does, it
 * will need to know that.
 */

let db: ApiDatabase;

beforeAll(() => {
  const connected = connectPostgres(process.env.DATABASE_URL);
  if (!connected) throw new Error('DATABASE_URL is not set; vitest.pg.globalSetup.ts must run.');
  db = connected;
});

afterAll(async () => {
  await closePostgres();
});

const MODEL = 'model-x';

/** Through `eq()` rather than a raw `sql` template — a bare `Date` bound into a
 * template fails inside the driver before the statement is ever sent. */
async function read(provider: string) {
  const [row] = await db
    .select()
    .from(providerHealth)
    .where(and(eq(providerHealth.provider, provider), eq(providerHealth.modelId, MODEL)));
  if (!row) throw new Error(`no provider_health row for ${provider}`);
  return row;
}

/** Drive a row to `n` consecutive real failures. */
async function failTimes(provider: string, n: number) {
  for (let i = 0; i < n; i += 1) {
    await recordProviderFailure(db, provider, MODEL, new Date(), false);
  }
}

describe('recording successes', () => {
  it('creates the row on the first success and ADDS on the second', async () => {
    const provider = 'ph-first';

    await recordProviderSuccess(db, provider, MODEL, 100, new Date());
    const first = await read(provider);
    expect(first.successCount).toBe(1);
    expect(first.totalRequests).toBe(1);
    expect(first.successRate).toBe(100);
    expect(first.averageLatencyMs).toBe(100);

    // The second call is what separates an increment from an overwrite: a
    // repository writing `success_count = 1` unconditionally passes the first
    // block and fails here.
    await recordProviderSuccess(db, provider, MODEL, 300, new Date());
    const second = await read(provider);
    expect(second.successCount).toBe(2);
    expect(second.totalRequests).toBe(2);
    expect(second.averageLatencyMs).toBe(200); // mean of [100, 300]
    expect(second.latencySamples).toEqual([100, 300]);
  });

  it('caps the latency window at 100 samples, keeping the NEWEST', async () => {
    const provider = 'ph-window';
    for (let i = 1; i <= 105; i += 1) {
      await recordProviderSuccess(db, provider, MODEL, i, new Date());
    }

    const row = await read(provider);
    expect(row.latencySamples).toHaveLength(100);
    // Oldest five dropped, newest kept. Asserting both ends is what would catch
    // a slice that kept the head instead of the tail — a window that keeps the
    // FIRST 100 also has length 100 and also looks correct.
    expect(row.latencySamples[0]).toBe(6);
    expect(row.latencySamples[99]).toBe(105);
    // ...while the counters keep counting past the cap.
    expect(row.successCount).toBe(105);
  });

  it('clears consecutive FAILURES without touching the failure total', async () => {
    const provider = 'ph-clears';
    await failTimes(provider, 2);
    expect((await read(provider)).consecutiveFailures).toBe(2);

    await recordProviderSuccess(db, provider, MODEL, 50, new Date());
    const row = await read(provider);
    expect(row.consecutiveFailures).toBe(0);
    // The cumulative count is history and must survive. A `$set` that reset both
    // would pass the line above.
    expect(row.failureCount).toBe(2);
  });
});

describe('the circuit breaker', () => {
  it(`opens after ${CIRCUIT_CONFIG.failureThreshold} consecutive real failures and NOT before`, async () => {
    const provider = 'ph-opens';

    await failTimes(provider, CIRCUIT_CONFIG.failureThreshold - 1);
    // The negative half. Without it, a breaker that opens on the FIRST failure
    // passes the positive assertion below.
    expect((await read(provider)).circuitState).toBe('closed');

    await failTimes(provider, 1);
    const row = await read(provider);
    expect(row.circuitState).toBe('open');
    expect(row.isHealthy).toBe(false);
    expect(row.circuitOpenedAt).not.toBeNull();
  });

  it('does NOT let rate limits open the circuit, however many arrive', async () => {
    const provider = 'ph-ratelimit';

    for (let i = 0; i < CIRCUIT_CONFIG.failureThreshold * 2; i += 1) {
      await recordProviderFailure(db, provider, MODEL, new Date(), true);
    }

    const row = await read(provider);
    expect(row.circuitState).toBe('closed');
    // A rate limit still COUNTS as traffic — it just is not evidence about the
    // provider's health. Asserting the totals moved is what stops this passing
    // for a repository that ignores rate limits entirely.
    expect(row.failureCount).toBe(CIRCUIT_CONFIG.failureThreshold * 2);
    expect(row.totalRequests).toBe(CIRCUIT_CONFIG.failureThreshold * 2);
    expect(row.consecutiveFailures).toBe(0);
  });

  it('closes a half-open circuit only after enough consecutive successes', async () => {
    const provider = 'ph-halfopen-closes';
    await failTimes(provider, CIRCUIT_CONFIG.failureThreshold);
    expect(await openCircuitForProbe(db, provider, MODEL)).toBe(1);
    expect((await read(provider)).circuitState).toBe('half-open');

    await recordProviderSuccess(db, provider, MODEL, 10, new Date());
    // One success is not enough — the threshold is 2.
    expect((await read(provider)).circuitState).toBe('half-open');
    expect((await read(provider)).halfOpenAttempts).toBe(1);

    await recordProviderSuccess(db, provider, MODEL, 10, new Date());
    const row = await read(provider);
    expect(row.circuitState).toBe('closed');
    expect(row.circuitOpenedAt).toBeNull();
    expect(row.halfOpenAttempts).toBe(0);
  });

  it('re-opens a half-open circuit on a SINGLE failure', async () => {
    const provider = 'ph-halfopen-reopens';
    await failTimes(provider, CIRCUIT_CONFIG.failureThreshold);
    await openCircuitForProbe(db, provider, MODEL);
    expect((await read(provider)).circuitState).toBe('half-open');

    await recordProviderFailure(db, provider, MODEL, new Date(), false);
    expect((await read(provider)).circuitState).toBe('open');
  });

  it('only probes a circuit that is OPEN', async () => {
    const provider = 'ph-probe-guard';
    await recordProviderSuccess(db, provider, MODEL, 10, new Date());
    expect((await read(provider)).circuitState).toBe('closed');

    // A closed circuit is not a candidate. Returning 0 rather than silently
    // half-opening a healthy provider is the whole point of the guard.
    expect(await openCircuitForProbe(db, provider, MODEL)).toBe(0);
    expect((await read(provider)).circuitState).toBe('closed');
  });

  it('re-derives isHealthy from the success rate once the sample is meaningful', async () => {
    const provider = 'ph-healthy';
    // 6 rate-limit failures + 4 successes = 10 requests, 40% success rate, and
    // rate limits mean the breaker itself never opened. So `is_healthy` can only
    // have moved via the success-rate branch, which is what this isolates.
    for (let i = 0; i < 6; i += 1) {
      await recordProviderFailure(db, provider, MODEL, new Date(), true);
    }
    for (let i = 0; i < 3; i += 1) {
      await recordProviderSuccess(db, provider, MODEL, 10, new Date());
    }
    // Nine requests: still below the threshold, so still healthy by default.
    expect((await read(provider)).totalRequests).toBe(9);
    expect((await read(provider)).isHealthy).toBe(true);

    await recordProviderSuccess(db, provider, MODEL, 10, new Date());
    const row = await read(provider);
    expect(row.totalRequests).toBe(CIRCUIT_CONFIG.minRequestsForMetrics);
    expect(row.successRate).toBeCloseTo(40, 5);
    expect(row.isHealthy).toBe(false);
    expect(row.circuitState).toBe('closed');
  });
});

describe('concurrency', () => {
  it('loses no count when 20 successes are recorded at once', async () => {
    const provider = 'ph-concurrent';

    await Promise.all(
      Array.from({ length: 20 }, () => recordProviderSuccess(db, provider, MODEL, 10, new Date())),
    );

    const row = await read(provider);
    expect(row.successCount).toBe(20);
    expect(row.totalRequests).toBe(20);
  });

  it('records 20 sequential successes too — the control for the case above', async () => {
    /**
     * The positive control for the concurrency assertion. A repository broken in
     * some way unrelated to concurrency — a bad statement, a wrong conflict
     * target — fails BOTH tests, and then the concurrent one proves nothing
     * about atomicity. Green here and red above is what isolates a lost update.
     */
    const provider = 'ph-sequential';

    for (let i = 0; i < 20; i += 1) {
      await recordProviderSuccess(db, provider, MODEL, 10, new Date());
    }

    expect((await read(provider)).successCount).toBe(20);
  });
});

describe('reads and single-row resets', () => {
  it('creates a default row on first read and does not move it on the second', async () => {
    const provider = 'ph-getorcreate';
    const created = await getOrCreateProviderHealth(db, provider, MODEL, new Date());
    expect(created.circuitState).toBe('closed');
    expect(created.totalRequests).toBe(0);
    expect(created.isHealthy).toBe(true);

    await recordProviderSuccess(db, provider, MODEL, 10, new Date());
    const again = await getOrCreateProviderHealth(db, provider, MODEL, new Date());
    // Same row, not a second one: a get-or-create that inserted every time would
    // report 0 here and would also violate the unique index.
    expect(again.id).toBe(created.id);
    expect(again.totalRequests).toBe(1);
  });

  it('resets one row to defaults while KEEPING its latency window', async () => {
    const provider = 'ph-reset-one';
    await failTimes(provider, CIRCUIT_CONFIG.failureThreshold);
    await recordProviderSuccess(db, provider, MODEL, 42, new Date());

    await resetProviderHealth(db, provider, MODEL, new Date());
    const row = await read(provider);
    expect(row.circuitState).toBe('closed');
    expect(row.totalRequests).toBe(0);
    expect(row.failureCount).toBe(0);
    expect(row.successRate).toBe(100);
    expect(row.isHealthy).toBe(true);
    // Deliberately preserved, matching the source: the reset addresses a stuck
    // circuit, and the latency window is observation rather than circuit state.
    expect(row.latencySamples).toEqual([42]);
  });

  it('lists rows newest-activity-first', async () => {
    const older = 'ph-list-older';
    const newer = 'ph-list-newer';
    await recordProviderSuccess(db, older, MODEL, 10, new Date());
    await recordProviderSuccess(db, newer, MODEL, 10, new Date());

    /**
     * `updated_at` is written explicitly rather than relying on the two writes
     * above landing in different milliseconds. The column defaults to
     * `date_trunc('milliseconds', now())`, so a sleep between them is a bet on
     * wall-clock resolution under whatever else the machine is doing — and the
     * assertion this test makes is about the repository's ORDER BY, not about
     * how fast two inserts can be. Relative instants, never absolute ones.
     */
    const base = Date.now();
    await db.update(providerHealth).set({ updatedAt: new Date(base - 60_000) })
      .where(and(eq(providerHealth.provider, older), eq(providerHealth.modelId, MODEL)));
    await db.update(providerHealth).set({ updatedAt: new Date(base) })
      .where(and(eq(providerHealth.provider, newer), eq(providerHealth.modelId, MODEL)));

    const rows = await listProviderHealth(db);
    const olderAt = rows.findIndex((r) => r.provider === older);
    const newerAt = rows.findIndex((r) => r.provider === newer);
    // Vacuity floor: both must actually be in the list, or the comparison below
    // is comparing two -1s and passes having measured nothing.
    expect(olderAt).toBeGreaterThanOrEqual(0);
    expect(newerAt).toBeGreaterThanOrEqual(0);
    expect(newerAt).toBeLessThan(olderAt);
  });
});

describe('the cooldown sweep', () => {
  it('half-opens a circuit past its cooldown and leaves a fresh one alone', async () => {
    const stale = 'ph-sweep-stale';
    const fresh = 'ph-sweep-fresh';
    await failTimes(stale, CIRCUIT_CONFIG.failureThreshold);
    await failTimes(fresh, CIRCUIT_CONFIG.failureThreshold);
    expect((await read(stale)).circuitState).toBe('open');
    expect((await read(fresh)).circuitState).toBe('open');

    // `now` is advanced rather than the fixture being back-dated: the cutoff is
    // computed from the argument, so moving the clock forward past one row's
    // cooldown is the same experiment with no absolute instant written anywhere.
    const later = new Date(Date.now() + CIRCUIT_CONFIG.openDurationMs + 1000);
    const moved = await halfOpenExpiredCircuits(db, later);

    expect((await read(stale)).circuitState).toBe('half-open');
    // At least the two this test opened; other tests in this file may have left
    // open circuits behind, so an exact count would be order-dependent.
    expect(moved).toBeGreaterThanOrEqual(2);

    // And the negative case, with the clock NOT advanced.
    await failTimes(fresh, CIRCUIT_CONFIG.failureThreshold);
    expect((await read(fresh)).circuitState).toBe('open');
    await halfOpenExpiredCircuits(db, new Date());
    expect((await read(fresh)).circuitState).toBe('open');
  });
});

/**
 * Last, because both statements here write EVERY row in the table.
 */
describe('the unfiltered operator resets', () => {
  it('closeAllCircuits closes open circuits and PRESERVES the traffic counters', async () => {
    const broken = 'ph-closeall-broken';
    const healthy = 'ph-closeall-healthy';
    await failTimes(broken, CIRCUIT_CONFIG.failureThreshold);
    await recordProviderSuccess(db, healthy, MODEL, 10, new Date());
    const healthyBefore = await read(healthy);
    expect((await read(broken)).circuitState).toBe('open');

    const closed = await closeAllCircuits(db, new Date());
    expect(closed).toBeGreaterThanOrEqual(1);

    const after = await read(broken);
    expect(after.circuitState).toBe('closed');
    expect(after.circuitOpenedAt).toBeNull();
    expect(after.consecutiveFailures).toBe(0);
    expect(after.isHealthy).toBe(true);
    /**
     * The distinction that matters, and the reason this is not the same function
     * as the one below: the failure history SURVIVES. Collapsing the two would
     * erase every provider's counters on each deploy, and every assertion above
     * would still pass.
     */
    expect(after.failureCount).toBe(CIRCUIT_CONFIG.failureThreshold);
    expect(after.totalRequests).toBe(CIRCUIT_CONFIG.failureThreshold);

    // An already-closed row is not in the filter, so its counters are untouched.
    expect((await read(healthy)).totalRequests).toBe(healthyBefore.totalRequests);
  });

  it('resetAllProviderHealth zeroes the counters on EVERY row, closed ones included', async () => {
    const provider = 'ph-resetall';
    await recordProviderSuccess(db, provider, MODEL, 10, new Date());
    await recordProviderSuccess(db, provider, MODEL, 10, new Date());
    expect((await read(provider)).totalRequests).toBe(2);

    const reset = await resetAllProviderHealth(db, new Date());
    // Every row in the table, so at least the many this file created.
    expect(reset).toBeGreaterThanOrEqual(2);

    const row = await read(provider);
    expect(row.totalRequests).toBe(0);
    expect(row.successCount).toBe(0);
    expect(row.successRate).toBe(100);
    expect(row.circuitState).toBe('closed');
    expect(row.isHealthy).toBe(true);
  });
});
