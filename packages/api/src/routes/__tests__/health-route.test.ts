import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RELAY_CLIENT_ENABLED_ENV } from '../../lib/inference/relay-cutover.js';

/**
 * What `/health`, `/health/ready` and `/health/live` actually RETURN — #139 ws8.
 *
 * ## Why this file exists
 *
 * The Relay half of these routes was guarded by a source-text assertion: that
 * `routes/health.ts` contained the string `relayBlocksReadiness()`. That proves
 * the route NAMES the function. It does not prove the route acts on the answer,
 * and the difference is not academic — measured on `main`, changing
 *
 *     if (relayBlocksReadiness())   ->   if (!relayBlocksReadiness())
 *
 * left the entire API suite green (101 files, 1387 tests) while inverting the
 * probe: the task then reported NOT READY exactly when Relay was reachable, and
 * ready when it was not. A guard that asserts the shape of a declaration and
 * never the semantics is the failure this whole verification pass keeps finding.
 *
 * So everything here drives the real express router over a real socket and reads
 * the STATUS CODE and the BODY. Nothing reads the source.
 *
 * ## Two properties that must survive any future edit
 *
 *  1. **`/health/live` consults nothing.** It is what the `oxy-alia` target
 *     group polls, so a dependency in it can get a task KILLED — the worst
 *     possible response to a dependency being briefly unavailable.
 *  2. **A cold task is READY.** Relay connectivity `unknown` must not remove a
 *     task from rotation, because a task out of rotation receives no request and
 *     could never acquire the evidence that would put it back in. That deadlock
 *     is the reason only an OBSERVED failure counts.
 */

/** A circuit that is open for the next minute, and one whose cooldown has passed. */
const UNAVAILABLE = { unavailableUntilMs: Date.now() + 60_000 } as const;
const LAPSED = { unavailableUntilMs: Date.now() - 1 } as const;

/**
 * One `provider_health` row, carrying only the columns the summary reads.
 *
 * The names are invented rather than real providers. Nothing here depends on
 * which provider it is — the credential check is a set membership test — and a
 * vendor name in a fixture is a vendor name in the repository.
 */
interface ProviderRow {
  readonly provider: string;
  /** Half the census key: the table is one row per (provider, model). */
  readonly modelId: string;
  readonly circuitState: string;
  readonly isHealthy: boolean;
  readonly lastSuccess: Date | null;
  readonly lastFailure: Date | null;
}

/** One entry in the routing table — what `total` is now counted from. */
interface Mapping {
  readonly provider: string;
  readonly modelId: string;
}

const pairOf = (row: ProviderRow): Mapping => ({ provider: row.provider, modelId: row.modelId });

/** Has completed a request. The positive control for every pessimism check. */
const SERVED: ProviderRow = {
  provider: 'served',
  modelId: 'm-served',
  circuitState: 'closed',
  isHealthy: true,
  lastSuccess: new Date(),
  lastFailure: null,
};

/**
 * The production row this whole change is about: created by a read, never
 * called, `is_healthy` still sitting at its schema default of `true`.
 */
const NEVER_CALLED: ProviderRow = {
  provider: 'cold',
  modelId: 'm-cold',
  circuitState: 'closed',
  isHealthy: true,
  lastSuccess: null,
  lastFailure: null,
};

/** Called, only ever failed, and too few requests for the breaker to have ruled. */
const ONLY_FAILED: ProviderRow = {
  provider: 'failing',
  modelId: 'm-failing',
  circuitState: 'closed',
  isHealthy: true,
  lastSuccess: null,
  lastFailure: new Date(),
};

/** The breaker has ruled: circuit open. */
const CIRCUIT_OPEN: ProviderRow = {
  provider: 'tripped',
  modelId: 'm-tripped',
  circuitState: 'open',
  isHealthy: false,
  lastSuccess: new Date(),
  lastFailure: new Date(),
};

/**
 * The breaker has ruled on the SUCCESS RATE without opening the circuit.
 *
 * A real state, not a contrivance: past `minRequestsForMetrics` both recording
 * paths set `is_healthy = successRate >= 50` on every write, and that can go
 * false while `consecutive_failures` never reaches the threshold that opens a
 * circuit. It matters here because `is_healthy` is false — which is what makes
 * a fleet where NOTHING serves also a fleet where `some(p => p.isHealthy)` is
 * false, and therefore the state the branch being deleted would have acted on.
 */
const BREAKER_RULED: ProviderRow = {
  provider: 'flaky',
  modelId: 'm-flaky',
  circuitState: 'closed',
  isHealthy: false,
  lastSuccess: new Date(),
  lastFailure: new Date(),
};

/**
 * The routing table as the gateway returns it: mappings keyed by TIER.
 *
 * Spelled out rather than flattened, because the duplication that matters is
 * ACROSS tiers — the real `TIER_MODEL_MAPPINGS` lists one pair once per tier
 * that routes to it. A fixture that repeats a pair inside a single tier tests a
 * shape the data never takes, which is how the dedup mutation first survived.
 */
type TierTable = Readonly<Record<string, readonly Mapping[]>>;

interface Dependencies {
  readonly postgresReady: boolean;
  readonly providers: readonly ProviderRow[];
  readonly credentialed: readonly string[];
  readonly configured: TierTable;
}

/** Postgres answers, the queue is up, and the gateway answers all three reads. */
function mockDependencies({ postgresReady, providers, credentialed, configured }: Dependencies): void {
  vi.doMock('../../db/index.js', () => ({
    getDb: () => ({
      execute: () =>
        postgresReady ? Promise.resolve([]) : Promise.reject(new Error('pool exhausted')),
    }),
  }));
  vi.doMock('../../lib/task-queue.js', () => ({ isQueueActive: () => true }));
  vi.doMock('../../lib/gateway-client.js', () => ({
    getTierMappings: () => Promise.resolve(configured),
    getAllProviderHealth: () => Promise.resolve([...providers]),
    providersWithUsableCredentials: () => Promise.resolve(new Set(credentialed)),
  }));
}

interface Probe {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** What this process has observed about Relay when the request arrives. */
type RelayState = 'no observation' | 'reachable' | { readonly unavailableUntilMs: number };

let server: Server | null = null;

/**
 * Mount the REAL router and answer one request against it.
 *
 * Everything is imported fresh per call, for two reasons that both bite:
 *
 *  1. the route's own 10-second snapshot cache must start empty, or `/health`
 *     answers the second state with the first state's body and the test measures
 *     the cache;
 *  2. **the connectivity state has to be written through the SAME module
 *     instance the route reads.** `vi.resetModules()` gives the route a fresh
 *     `relay-connectivity.js`, so a state written through a statically imported
 *     copy reaches a registry nobody reads — which is how the first draft of
 *     this file reported a cold `unknown` for every state, including one test
 *     that then passed for entirely the wrong reason.
 */
async function probe(
  path: string,
  {
    postgresReady = true,
    relay = 'no observation' as RelayState,
    providers = [SERVED] as readonly ProviderRow[],
    credentialed = providers.map((p) => p.provider) as readonly string[],
    // Default: one tier configuring exactly the pairs the fixtures carry rows
    // for, which is the shape every pre-existing case assumed.
    configured = { 'tier-a': providers.map(pairOf) } as TierTable,
  } = {},
): Promise<Probe> {
  vi.resetModules();
  mockDependencies({ postgresReady, providers, credentialed, configured });

  const connectivity = await import('../../lib/inference/relay-connectivity.js');
  if (relay === 'reachable') connectivity.reportRelayReachable();
  else if (relay !== 'no observation') {
    connectivity.reportRelayUnavailableUntil(relay.unavailableUntilMs);
  }

  const { default: healthRouter } = await import('../health.js');

  const app = express();
  app.use('/health', healthRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(async () => {
  if (server !== null) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  vi.doUnmock('../../db/index.js');
  vi.doUnmock('../../lib/task-queue.js');
  vi.doUnmock('../../lib/gateway-client.js');
});

/* -------------------------------------------------------------------------- */
/*  The harness measures the route, not itself                                 */
/* -------------------------------------------------------------------------- */

describe('the probe reaches the real router', () => {
  it('serves a healthy snapshot when every dependency answers', async () => {
    // The positive control for every assertion below. If the mount were wrong,
    // a 404 body would satisfy most "does not say X" checks.
    const { status, body } = await probe('/health');
    expect(status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.postgres).toBe('connected');

    // Vacuity floor, and it is not decoration: the provider summary is built
    // inside a `try` whose `catch` reports "gateway unreachable, do not
    // penalise". A mock missing ONE of the two provider reads throws, lands in
    // that catch, and every assertion above passes with the summary at zero —
    // measured, when `providersWithUsableCredentials` was added to the route
    // and not to the mock. Naming the counts is what tells the two apart.
    expect(body.providers).toEqual({
      total: 1,
      healthy: 1,
      unhealthy: 0,
      unusable: 0,
      unknown: 0,
      openCircuits: 0,
    });
  });

  it('discriminates: a dependency that is down changes the answer', async () => {
    // Without this the suite could pass against a route that returned a constant.
    const { status, body } = await probe('/health', { postgresReady: false });
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.postgres).toBe('unavailable');
  });
});

/* -------------------------------------------------------------------------- */
/*  /health/live consults nothing                                              */
/* -------------------------------------------------------------------------- */

describe('/health/live answers only "this process is running"', () => {
  it('is 200 with the database down', async () => {
    const { status, body } = await probe('/health/live', { postgresReady: false });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'alive' });
  });

  it('is 200 with Relay observed unreachable after the cutover', async () => {
    // The target group polls this. A Relay outage must not get every task killed
    // and replaced, which is what a failing LIVENESS probe means.
    vi.stubEnv(RELAY_CLIENT_ENABLED_ENV, 'true');
    const { status, body } = await probe('/health/live', { relay: UNAVAILABLE });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'alive' });
  });
});

/* -------------------------------------------------------------------------- */
/*  Readiness, per connectivity state                                          */
/* -------------------------------------------------------------------------- */

/**
 * Relay is REPORTED by readiness and never acted on by it.
 *
 * `/health/ready` used to answer 503 `relay_unreachable` on an open circuit.
 * The observation is per-process, but Relay being unreachable is not a per-task
 * fact — every task discovers the same outage within a probe interval and they
 * all deregister together, which is the outage `relay-connectivity.ts`'s own
 * header is written against. Two specifics decide it: `provider_overloaded` and
 * `provider_timeout` are among the four codes that open that circuit, so the
 * gate would have deregistered the fleet on UPSTREAM PROVIDER state; and Relay
 * implements `AliaInferencePort` alone, so a task that cannot reach it still
 * serves authentication, conversation reads, billing and MCP.
 *
 * So the body still names the state — every case below reads it — and the
 * status code no longer moves with it.
 */
describe('/health/ready reports Relay connectivity without acting on it', () => {
  it('is ready and reports disabled while the cutover flag is off', async () => {
    // Every deployment that exists. Recorded as a status code so a change to it
    // is a change to this test, not a comment.
    const { status, body } = await probe('/health/ready', { relay: UNAVAILABLE });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ready', relay: 'disabled' });
  });

  it('is ready on a COLD task, which is the deadlock this avoids', async () => {
    vi.stubEnv(RELAY_CLIENT_ENABLED_ENV, 'true');
    const { status, body } = await probe('/health/ready');
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ready', relay: 'unknown' });
  });

  it('is ready once a call has completed', async () => {
    vi.stubEnv(RELAY_CLIENT_ENABLED_ENV, 'true');
    const { status, body } = await probe('/health/ready', { relay: 'reachable' });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ready', relay: 'reachable' });
  });

  it('is READY while the circuit is open, and says so in the same breath', async () => {
    /**
     * The case that changed, and the one a re-added gate makes 503.
     *
     * `relay: 'unreachable'` in a 200 body is the whole design in one line: the
     * task reports the outage truthfully and stays in rotation, because taking
     * it out would remove every task at once and take authentication,
     * conversations, billing and MCP down with inference.
     */
    vi.stubEnv(RELAY_CLIENT_ENABLED_ENV, 'true');
    const { status, body } = await probe('/health/ready', { relay: UNAVAILABLE });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ready', relay: 'unreachable' });
  });

  it('is ready again once the cooldown lapses, without anything clearing it', async () => {
    vi.stubEnv(RELAY_CLIENT_ENABLED_ENV, 'true');
    const { status, body } = await probe('/health/ready', { relay: LAPSED });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ready', relay: 'unknown' });
  });

  it('refuses on Postgres even while Relay is also unreachable', async () => {
    // The remaining condition still fires when Relay is down too, and it names
    // the fault an operator should go and look at. With the Relay gate gone
    // this is also the only 503 `/health/ready` can produce.
    vi.stubEnv(RELAY_CLIENT_ENABLED_ENV, 'true');
    const { status, body } = await probe('/health/ready', { postgresReady: false, relay: UNAVAILABLE });
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'not_ready', reason: 'database_unavailable' });
  });
});

/* -------------------------------------------------------------------------- */
/*  The snapshot                                                               */
/* -------------------------------------------------------------------------- */

describe('/health names Relay in the snapshot', () => {
  it('reports disabled and stays healthy while the cutover flag is off', async () => {
    const { status, body } = await probe('/health', { relay: UNAVAILABLE });
    expect(status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.relay).toBe('disabled');
  });

  it('degrades when Relay is observed unreachable after the cutover', async () => {
    vi.stubEnv(RELAY_CLIENT_ENABLED_ENV, 'true');
    const { status, body } = await probe('/health', { relay: UNAVAILABLE });
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.relay).toBe('unreachable');
  });

  it('stays healthy when Relay is reachable after the cutover', async () => {
    // The control that makes the degradation above about Relay's STATE rather
    // than about the flag being on.
    vi.stubEnv(RELAY_CLIENT_ENABLED_ENV, 'true');
    const { status, body } = await probe('/health', { relay: 'reachable' });
    expect(status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.relay).toBe('reachable');
  });
});

/* -------------------------------------------------------------------------- */
/*  A provider is healthy only on evidence that it served                      */
/* -------------------------------------------------------------------------- */

/**
 * The defect these assert against, measured on `api.alia.onl` on 2026-08-19:
 *
 *     "providers":{"total":26,"healthy":26,"unhealthy":0,"openCircuits":0}
 *
 * from a task holding no LLM provider credential at all. `is_healthy` defaults
 * to `true` and only a recorded failure ever clears it, so the count answered
 * "26 healthy" for a fleet that could not serve one request — the same answer it
 * would give if every provider on earth were down.
 *
 * ## How to break these on purpose
 *
 * Two mutations, both applied and both measured red before this landed:
 *
 *  1. count `unknown` as healthy — i.e. restore "a row nothing has called is
 *     healthy". Every never-called case below flips to 200/healthy.
 *  2. delete the credential term from `classifyProvider` — the `unusable` cases
 *     flip to healthy on the strength of a stale `last_success`.
 *
 * Each assertion below names the whole summary object rather than one count, so
 * a mutation cannot move a row between two states unobserved.
 */
describe('/health tells never-called apart from healthy (and both from unusable)', () => {
  it('reports a never-called provider as unknown, and the service as degraded', async () => {
    // THE defect. `isHealthy` is true and the circuit is closed, exactly as the
    // schema default leaves it — and this must not be enough.
    const { status, body } = await probe('/health', { providers: [NEVER_CALLED] });
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.providers).toEqual({
      total: 1,
      healthy: 0,
      unhealthy: 0,
      unusable: 0,
      unknown: 1,
      openCircuits: 0,
    });
  });

  it('reports a provider with no credential as unusable, whatever its history', async () => {
    // A row carrying a real success, with the credential since removed. History
    // must not outrank the fact that there is nothing left to serve with.
    const { status, body } = await probe('/health', { providers: [SERVED], credentialed: [] });
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.providers).toEqual({
      total: 1,
      healthy: 0,
      unhealthy: 0,
      unusable: 1,
      unknown: 0,
      openCircuits: 0,
    });
  });

  it('still reports a provider that has actually served as healthy', async () => {
    // The other-direction control. Without it, an endpoint hard-wired to
    // "degraded" would satisfy every assertion above and measure nothing.
    const { status, body } = await probe('/health', { providers: [SERVED] });
    expect(status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.providers).toEqual({
      total: 1,
      healthy: 1,
      unhealthy: 0,
      unusable: 0,
      unknown: 0,
      openCircuits: 0,
    });
  });

  it('one healthy provider among broken ones is enough, as it always was', async () => {
    // The pre-existing `healthy > 0` rule, unchanged. This is what keeps the
    // change from being "degrade whenever anything is wrong".
    const { status, body } = await probe('/health', {
      providers: [SERVED, NEVER_CALLED, CIRCUIT_OPEN],
    });
    expect(status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.providers).toEqual({
      total: 3,
      healthy: 1,
      unhealthy: 1,
      unusable: 0,
      unknown: 1,
      openCircuits: 1,
    });
  });

  it('counts a provider that has only ever failed as unhealthy, not unknown', async () => {
    // Below `minRequestsForMetrics` the breaker has not ruled, so `is_healthy`
    // is still true and the circuit still closed. Every observation of it is a
    // failure, which is a verdict — the absence of one is what `unknown` means.
    const { status, body } = await probe('/health', { providers: [ONLY_FAILED] });
    expect(status).toBe(503);
    expect(body.providers).toEqual({
      total: 1,
      healthy: 0,
      unhealthy: 1,
      unusable: 0,
      unknown: 0,
      openCircuits: 0,
    });
  });

  it('the four states partition the rows exactly', () => {
    // Stated as arithmetic over the case above rather than left implicit: a
    // future fifth state that forgets to be counted shows up as a total that no
    // longer adds up, in a test that names the sum.
    const summary = { total: 3, healthy: 1, unhealthy: 1, unusable: 0, unknown: 1 };
    expect(summary.healthy + summary.unhealthy + summary.unusable + summary.unknown).toBe(
      summary.total,
    );
  });

  it('reproduces the production answer, and gives the opposite verdict', async () => {
    // 26 rows created by a READ (`routes/models-stats.ts` calls
    // `getProviderHealth` per tier mapping, which INSERTS a default row), on a
    // deployment holding no provider credential. The old code called this
    // "26 healthy".
    const table = Array.from({ length: 26 }, (_, i) => ({
      ...NEVER_CALLED,
      provider: `cold-${i}`,
    }));
    const { status, body } = await probe('/health', { providers: table, credentialed: [] });
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.providers).toEqual({
      total: 26,
      healthy: 0,
      unhealthy: 0,
      unusable: 26,
      unknown: 0,
      openCircuits: 0,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  `total` counts configuration, not traffic                                  */
/* -------------------------------------------------------------------------- */

/**
 * Measured in production on 2026-08-19: `/health` reported `total: 26` in the
 * afternoon and `total: 50` an hour later — same deployment, no configuration
 * change, nothing deployed in between. Someone browsed a page,
 * `getOrCreateProviderHealth` inserted rows, and a public endpoint's headline
 * count nearly doubled while nothing in the system had changed.
 *
 * The census now walks the ROUTING TABLE and looks each pair up in telemetry,
 * so the number moves only when configuration does.
 */
describe('the provider census counts what is configured', () => {
  it('counts a configured pair that has no telemetry row at all', async () => {
    // The fresh-deployment case, and the one the old census could not express:
    // walking the rows, a pair nothing had touched simply did not exist.
    const { body } = await probe('/health', {
      providers: [],
      configured: { lite: [{ provider: 'cold', modelId: 'm1' }] },
      credentialed: ['cold'],
    });
    expect(body.providers).toEqual({
      total: 1,
      healthy: 0,
      unhealthy: 0,
      unusable: 0,
      unknown: 1,
      openCircuits: 0,
    });
  });

  it('gives the same total whether or not rows have been manufactured', async () => {
    /**
     * THE assertion. Identical configuration, two different amounts of
     * telemetry — the exact difference between the 26 reading and the 50
     * reading. `total` must not move.
     */
    const configured = {
      lite: [
        { provider: 'a', modelId: 'm1' },
        { provider: 'b', modelId: 'm2' },
        { provider: 'c', modelId: 'm3' },
      ],
    };
    const credentialed = ['a', 'b', 'c'];

    const cold = await probe('/health', { providers: [], configured, credentialed });
    const browsed = await probe('/health', {
      providers: [
        { ...NEVER_CALLED, provider: 'a', modelId: 'm1' },
        { ...NEVER_CALLED, provider: 'b', modelId: 'm2' },
      ],
      configured,
      credentialed,
    });

    expect((cold.body.providers as { total: number }).total).toBe(3);
    expect((browsed.body.providers as { total: number }).total).toBe(3);
    // ...and the verdict is identical too, because a row created by a READ says
    // nothing that a missing row does not.
    expect(cold.body.providers).toEqual(browsed.body.providers);
  });

  it('ignores a telemetry row for a pair the routing table does not configure', async () => {
    /**
     * A stale row — a provider or model no longer mapped. It cannot be routed
     * to, so it cannot affect whether the service can serve, and counting it
     * would put the traffic-dependence straight back.
     */
    const { body } = await probe('/health', {
      providers: [SERVED, { ...SERVED, provider: 'retired', modelId: 'm-gone' }],
      configured: { lite: [pairOf(SERVED)] },
      credentialed: ['served', 'retired'],
    });
    expect(body.providers).toEqual({
      total: 1,
      healthy: 1,
      unhealthy: 0,
      unusable: 0,
      unknown: 0,
      openCircuits: 0,
    });
  });

  it('counts a pair once however many tiers route to it', async () => {
    /**
     * `TIER_MODEL_MAPPINGS` lists a pair once per TIER: 119 listings across 14
     * tiers reduce to 58 distinct pairs. Counting listings would report a number
     * more than twice the truth, and it would grow whenever a tier was added
     * without a single new provider existing.
     */
    const shared = { provider: 'a', modelId: 'm1' };
    const { body } = await probe('/health', {
      providers: [],
      credentialed: ['a'],
      // Three tiers routing to the same pair, and one of them to a second —
      // exactly how the real table repeats itself.
      configured: {
        lite: [shared],
        pro: [shared],
        max: [shared, { provider: 'a', modelId: 'm2' }],
      },
    });
    // Four listings across three tiers, two distinct pairs.
    expect((body.providers as { total: number }).total).toBe(2);
  });

  it('still reads the telemetry it does have, for the pairs it counts', async () => {
    // The positive control for the census as a whole: the lookup really joins
    // rows to configuration, so the states above are not all reachable through
    // "no row found" alone.
    const { body } = await probe('/health', {
      providers: [SERVED, CIRCUIT_OPEN],
      configured: { lite: [pairOf(SERVED), pairOf(CIRCUIT_OPEN)], pro: [{ provider: 'served', modelId: 'm-extra' }] },
      credentialed: ['served', 'tripped'],
    });
    expect(body.providers).toEqual({
      total: 3,
      healthy: 1,
      unhealthy: 1,
      unusable: 0,
      unknown: 1,
      openCircuits: 1,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  Readiness answers for the TASK, never for the fleet                        */
/* -------------------------------------------------------------------------- */

/**
 * The blast radius, asserted rather than argued.
 *
 * `oxy-infra#77` moves the `oxy-alia` target group from `/health/live` to
 * `/health/ready`, so this endpoint is about to decide whether production has
 * any registered targets at all. Every provider fact it could consult is read
 * from `provider_health` and `provider_keys` — single tables shared by every
 * task — so such a condition is true for the WHOLE FLEET or for none of it.
 * Acting on one deregisters every task at the same instant and takes down
 * authentication, conversations, billing, MCP and the admin routes with it,
 * then deadlocks: a task out of rotation gets no request, so no probe succeeds,
 * so nothing ever recovers.
 *
 * Hence the split these cases enforce: `/health/ready` answers "can THIS TASK
 * serve the API", `/health` answers "can the FLEET serve inference". Both
 * answers stay honest; only the first one may move a target out of rotation.
 *
 * The criterion is NOT "is the signal process-local" — Relay's observation is
 * per-process and still failed, because that says where the evidence is stored
 * and not where the fault is. It is **does this task's failure DIFFER from its
 * siblings'**, since deregistering only helps if there is a healthier task to
 * receive the request instead.
 *
 * Every case below drives the real router and reads the status code, because
 * the status code is the entire behaviour under discussion.
 */
describe('readiness answers for the task, and /health keeps the fleet-wide truth', () => {
  /**
   * Nothing serves: one open circuit, one the breaker ruled against.
   *
   * BOTH carry `is_healthy: false`, and that is load-bearing rather than
   * incidental. The branch being deleted existed in two forms over this
   * project's history — `!providers.some(p => p.isHealthy)` before #234 and
   * `healthy === 0 && unhealthy > 0` after it — and a fixture must trip BOTH or
   * it cannot prove the deletion. Measured: the first draft paired the open
   * circuit with `ONLY_FAILED`, whose `is_healthy` is still true because the
   * breaker has not ruled, so `some(isHealthy)` was TRUE, the pre-#234 branch
   * never fired, and re-adding it left the whole suite GREEN.
   */
  const NOTHING_SERVES = [CIRCUIT_OPEN, BREAKER_RULED] as const;

  it('/health/live is 200 with every provider unusable', async () => {
    const { status, body } = await probe('/health/live', {
      providers: [NEVER_CALLED],
      credentialed: [],
    });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'alive' });
  });

  it('/health/ready is 200 with every provider unusable and never called', async () => {
    // Production's exact state as of 2026-08-19: 26 rows, no credential.
    const { status, body } = await probe('/health/ready', {
      providers: [NEVER_CALLED, { ...NEVER_CALLED, provider: 'cold-2' }],
      credentialed: [],
    });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ready', relay: 'disabled' });
  });

  it('/health/ready is 200 even when the fleet WATCHED every provider fail', async () => {
    /**
     * THE case. This is the state that would deregister every task at once, and
     * it is the one a re-added provider condition — in any form, `!some(healthy)`
     * or `healthy === 0 && unhealthy > 0` or a count — makes 503.
     *
     * Inference is genuinely dead here. The task is still the right place to
     * send a request to, because the API is far more than inference and the
     * load balancer has nowhere better to send it.
     */
    const { status, body } = await probe('/health/ready', { providers: [...NOTHING_SERVES] });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ready', relay: 'disabled' });
  });

  it('/health reports that same fleet as degraded, so nothing is hidden', async () => {
    // The other half of the split, in the SAME state as the case above. Without
    // this pair, "readiness ignores providers" would be indistinguishable from
    // "nobody reports providers".
    const { status, body } = await probe('/health', { providers: [...NOTHING_SERVES] });
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.providers).toEqual({
      total: 2,
      healthy: 0,
      unhealthy: 2,
      unusable: 0,
      unknown: 0,
      openCircuits: 1,
    });
  });

  it('/health/ready is 200 while one provider still serves', async () => {
    const { status, body } = await probe('/health/ready', {
      providers: [SERVED, CIRCUIT_OPEN],
    });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ready', relay: 'disabled' });
  });

  it('/health/ready still refuses on the ONE condition that survives the test', async () => {
    /**
     * The discriminator. Without it every assertion above is satisfied by an
     * endpoint hard-wired to 200, which would be a probe that cannot fail —
     * precisely the defect `/health/live` is being moved away from.
     *
     * Postgres passes the test the other two failed: a pool can be broken,
     * exhausted or mid-failover for THIS task while its sibling is fine, and
     * then deregistering moves traffic somewhere that works. In the total case
     * nothing is lost either — a task that cannot reach Postgres can serve no
     * route at all, so the balancer had nothing to deliver.
     */
    const { status, body } = await probe('/health/ready', {
      postgresReady: false,
      providers: [SERVED],
    });
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'not_ready', reason: 'database_unavailable' });
  });
});

/**
 * `relay` and `kaana` answer different questions, and the snapshot says both.
 *
 * `relay` reports the cutover flag, so it reads `disabled` on every deployment
 * that exists — including production, where Kaana serves every background
 * derivation. Read as "Kaana is off", which is what it looks like, it says the
 * opposite of the truth.
 */
describe('what the snapshot says about Kaana', () => {
  const KAANA_ENV = {
    KAANA_EDGE_KEY_ID: 'alia-edge-test',
    KAANA_EDGE_SIGNING_PRIVATE_KEY: 'a key this test never parses',
  };

  it('says configured when the process has what it needs, whatever the flag says', async () => {
    for (const [name, value] of Object.entries(KAANA_ENV)) vi.stubEnv(name, value);
    const { body } = await probe('/health');

    expect(body.kaana).toBe('configured');
    // The whole point of the pair: the older field still reads `disabled`, and
    // a reader who had only that one would conclude Kaana was not in use.
    expect(body.relay).toBe('disabled');
  });

  it('says not_configured when it does not', async () => {
    // Negative control. Without it, a field hard-coded to `configured` would
    // pass the case above.
    for (const name of Object.keys(KAANA_ENV)) vi.stubEnv(name, '');
    const { body } = await probe('/health');
    expect(body.kaana).toBe('not_configured');
  });

  it('does not let either field decide readiness', async () => {
    // Neither may deregister a task: `/health/live` is what the target group
    // polls, and readiness reports rather than gates.
    for (const name of Object.keys(KAANA_ENV)) vi.stubEnv(name, '');
    const { status } = await probe('/health/ready');
    expect(status).toBe(200);
  });
});
