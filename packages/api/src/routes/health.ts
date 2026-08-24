import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import {
  getAllProviderHealth,
  getTierMappings,
  providersWithUsableCredentials,
  type HealthMetrics,
} from '../lib/gateway-client.js';
import { relayConnectivity } from '../lib/inference/relay-connectivity.js';
import { unsetKaanaVariables } from '../lib/inference/kaana.js';
import { isQueueActive } from '../lib/task-queue.js';
import { log } from '../lib/logger.js';

/**
 * Liveness, readiness and the detailed snapshot.
 *
 * ## Readiness asks the DATABASE, not the driver
 *
 * The previous version read `mongoose.connection.readyState`, which is the
 * driver's opinion of its own socket. This issues a real statement against the
 * store the service actually reads, so a pool that is connected but cannot serve
 * — exhausted, or pointed at a database the role cannot open — reports not-ready
 * instead of ready. A connection flag cannot distinguish those.
 *
 * ## `/live` is deliberately unconditional, and that is a trap worth naming
 *
 * `/live` answers "is this process running", so it must not consult a
 * dependency: a liveness probe that fails on a database blip gets the task
 * KILLED and replaced, which is the worst possible response to the database
 * being briefly unavailable. Readiness is the probe that removes a task from
 * rotation.
 *
 * The trap is that the two are easy to point at the wrong way round. As of this
 * change the `oxy-alia` target group health-checks `/health/live`, so a task
 * whose database is unreachable is still marked healthy and still receives
 * traffic — every request then fails behind a green check. Moving the target
 * group to `/health/ready` lives in `oxy-infra` and must happen BEFORE this
 * service is scaled up again.
 *
 * ## Relay is reported, and the report is additive (#139 ws8)
 *
 * `/health` and `/health/ready` both name Relay now. Both are ADDITIVE for every
 * deployment that exists: `relayConnectivity()` returns `'disabled'` while
 * `ALIA_RELAY_CLIENT_ENABLED` is not exactly `true`, which is everywhere, and
 * `'disabled'` neither degrades the snapshot nor blocks readiness. The status
 * code either route returns today is therefore unchanged, and only the response
 * body gains a field.
 *
 * `/health/live` is not touched. It is what the `oxy-alia` target group polls,
 * so a change to it is a change to whether the ALB keeps a task in rotation —
 * and the Relay signal has no business in a LIVENESS answer anyway. Only after
 * the target group moves to `/health/ready` does any of this reach the ALB, and
 * that move is `oxy-infra`'s.
 *
 * ## Mongo is not reported here, and there is nothing left to report
 *
 * This said "Mongoose call sites remain until the last domain is ported". They
 * do not: the port finished, `lib/db.ts` was deleted with the connection it
 * opened, and `db/__tests__/bootWiring.test.ts` walks the import graph from
 * `src/index.ts` and asserts the driver is unreachable from the boot path.
 *
 * ## A provider is not healthy because nothing has ever asked it
 *
 * Measured in production on 2026-08-19: `/health` answered
 * `"providers":{"total":26,"healthy":26,"unhealthy":0,"openCircuits":0}` from a
 * task carrying no LLM provider credential of any kind. Not one of those 26
 * could have served a request.
 *
 * The count was `providers.filter(p => p.isHealthy)`, and `is_healthy` defaults
 * to `true` — in the schema, in `getOrCreateProviderHealth`, and in the
 * catch-branch of `getProviderHealth`. `recordFailure` is the only thing that
 * ever makes it false, so a provider nothing has called is indistinguishable
 * from one that works. Apply the standing test to it: what would that check
 * report if every provider were unusable? Twenty-six healthy. The same answer
 * it gave. It measured nothing.
 *
 * The rows exist because a READ creates them. `routes/models-stats.ts` calls
 * `getProviderHealth(provider, modelId)` per tier mapping, and that lands in
 * `getOrCreateProviderHealth`, which INSERTS a default row when none is found.
 * One request to the public stats route is enough to populate the whole table
 * with healthy-looking providers that have never been called.
 *
 * So a row is now classified into one of four states rather than a boolean, and
 * `healthy` is the one that requires POSITIVE evidence:
 *
 *  - **`unusable`** — no credential this deployment could serve with. Checked
 *    first because it is the root cause and it outranks any history: a provider
 *    that succeeded last month and whose key has since been removed cannot
 *    serve now.
 *  - **`unhealthy`** — the circuit is open, or the breaker has ruled against it,
 *    or everything ever observed of it is a failure.
 *  - **`healthy`** — it has completed at least one request. `last_success` is
 *    the evidence, and nothing else can stand in for it.
 *  - **`unknown`** — never called. The state the previous version had no name
 *    for and reported as healthy.
 *
 * The four partition the census exactly; `openCircuits` stays the overlapping
 * detail it has always been. No provider NAME appears in the response — these
 * are counts, and `/health` is public and unauthenticated.
 *
 * ## `total` counts what is CONFIGURED, and it used to count what had been READ
 *
 * The census walks `TIER_MODEL_MAPPINGS` — the routing table — and looks each
 * pair up in `provider_health`. It used to walk `provider_health` itself, and
 * that is a different question with a badly misleading answer, because rows in
 * that table are created ON DEMAND by `getOrCreateProviderHealth`.
 *
 * **Measured in production on 2026-08-19: `total` read 26 in the afternoon and
 * 50 an hour later, on the same deployment, with no configuration change and
 * nothing deployed in between.** Someone browsed a page; a read inserted rows;
 * a public endpoint's headline count nearly doubled while nothing in the system
 * had changed. A reader watching that number would have gone looking for a cause
 * that did not exist. It plateaus once the provider×model cross-product fills,
 * which makes it worse rather than better: it looks stable exactly when someone
 * has finished being misled by it.
 *
 * This is the property that was already refused one paragraph up — no staleness
 * window on `last_success`, because it would make the endpoint a function of
 * TRAFFIC. The row count had that defect natively. Now a fresh deployment and a
 * heavily browsed one report the same `total`, and the number moves only when
 * the routing table does. `routes/models-stats.ts` stopped manufacturing the
 * rows in the same batch; this stops depending on them.
 *
 * A pair is counted once however many tiers route to it: 119 listings across 14
 * tiers are 58 distinct pairs, and counting listings would report a number more
 * than twice the truth that grew whenever a tier was added.
 *
 * A `provider_health` row for a pair NOT in the routing table is deliberately
 * ignored. It cannot be routed to, so it cannot affect whether the service can
 * serve — and including it would put the traffic-dependence straight back.
 *
 * ### `healthy` deliberately has no staleness window
 *
 * A success from six months ago still counts. The tempting refinement — expire
 * `last_success` after some window — makes the endpoint a function of TRAFFIC:
 * a quiet night would degrade the service and, after the target group moves,
 * take tasks out of rotation for having been idle. Absence of a credential is
 * the durable fact worth reporting, and it is reported.
 *
 * ## Readiness answers for the TASK, and only one condition qualifies
 *
 * `/health/ready` used to conflate two questions:
 *
 *  - **can THIS TASK serve the API** — the only thing that may deregister it;
 *  - **can the FLEET serve inference** — a report, and nothing more.
 *
 * The test that separates them is NOT "is the signal process-local". It is
 * **does this task's failure DIFFER from its siblings' failure** — because
 * deregistering is only ever useful if there is a healthier task to send the
 * request to instead. A condition every task meets at once does not move
 * traffic anywhere; it removes every target and turns a partial outage into a
 * total one, taking authentication, conversations, billing, MCP and the admin
 * routes down with the feature that actually broke. It also deadlocks: a task
 * out of rotation gets no request, so no probe is attempted, so nothing
 * recovers without a human.
 *
 * Two conditions were removed against that test, and one survives it.
 *
 * ### `no_healthy_providers` — removed
 *
 * Read from `provider_health` and `provider_keys`, single tables every task
 * shares, so it is true for the whole fleet or for none of it. It could never
 * distinguish one task from another.
 *
 * ### `relay_unreachable` — removed, and this one LOOKED process-local
 *
 * The observation is a module-level `let` in `relay-connectivity.ts`, which is
 * genuinely per-process — but that describes where the EVIDENCE is stored, not
 * where the FAULT is. If Relay is unreachable it is unreachable for every task,
 * and each simply discovers the same shared outage independently within a probe
 * interval. They then deregister together, which is the case above wearing a
 * different hat.
 *
 * Two facts settle it beyond the general argument, and both are checkable:
 *
 *  1. **Two of the four codes that open the circuit are not about Relay at
 *     all.** `CIRCUIT_TRIPPING_CODES` in `relay-client.ts` is
 *     `service_unavailable`, `deployment_unavailable`, `provider_overloaded`,
 *     `provider_timeout`. The last two are UPSTREAM PROVIDER conditions, so
 *     this branch would have deregistered the fleet on exactly the provider
 *     state the previous section removed — re-entering through the Relay door.
 *  2. **A task that cannot reach Relay still serves nearly everything.** Relay
 *     implements `AliaInferencePort` and nothing else; `product-seam.ts` puts
 *     the catalogue, provider selection, health and keys explicitly outside it.
 *     Keeping such a task in rotation is worth a great deal, not nothing.
 *
 * Relay is still REPORTED, on `/health` and in `/health/ready`'s own body. Only
 * its power to deregister is gone.
 *
 * ### Postgres — kept, and it is the one that passes
 *
 * `select 1` through THIS task's pool. One database serves every task, so a
 * total outage does hit all of them — but a pool can be broken, exhausted or
 * mid-failover for ONE task while its sibling is fine, and in that case
 * deregistering moves traffic to something that works. That is the whole
 * property. And in the total case nothing is lost: a task that cannot reach
 * Postgres can serve no route at all, so the balancer had nothing to deliver.
 *
 * ### Why this is not merely theoretical
 *
 * `oxy-infra#77` moves the `oxy-alia` target group from `/health/live` to
 * `/health/ready`, so this endpoint is about to decide whether production has
 * any registered targets. `__tests__/health-route.test.ts` asserts every one of
 * the above as a status code.
 */

const router = Router();

// ============== HEALTH STATE CACHE ==============
// Avoid querying providers on every health check

let healthCache: { data: unknown; expiry: number } | null = null;
const HEALTH_CACHE_TTL_MS = 10_000; // 10 seconds

/**
 * One real statement against Postgres.
 *
 * Returns a boolean rather than throwing, because both callers want to REPORT
 * the failure rather than propagate it. `getDb()` throwing (Postgres never
 * connected) and the query failing (connected, but not usable) are the same
 * answer to the only question being asked.
 */
async function isPostgresReady(): Promise<boolean> {
  try {
    await getDb().execute(sql`select 1`);
    return true;
  } catch (err) {
    log.general.warn({ err }, 'Health: Postgres probe failed');
    return false;
  }
}

/** The four states a configured provider can be in. They partition the census. */
type ProviderState = 'healthy' | 'unhealthy' | 'unusable' | 'unknown';

interface ProviderSummary {
  total: number;
  healthy: number;
  unhealthy: number;
  unusable: number;
  unknown: number;
  openCircuits: number;
}

const NO_PROVIDERS: ProviderSummary = {
  total: 0,
  healthy: 0,
  unhealthy: 0,
  unusable: 0,
  unknown: 0,
  openCircuits: 0,
};

/**
 * Which of the four a configured provider is in. The order of the tests IS the
 * precedence; see the module comment for why each one sits where it does.
 *
 * `row` is undefined when the pair is configured but has no telemetry at all —
 * the honest majority on a fresh deployment, and `unknown` is exactly what that
 * means. It is tested AFTER the credential, because "there is nothing to serve
 * with" outranks "nothing has been recorded".
 *
 * `lastSuccess` arrives as a `Date` from Postgres and as a string over the
 * gateway's JSON, so it is tested for presence rather than read.
 */
function classifyProvider(
  provider: string,
  row: HealthMetrics | undefined,
  credentialed: ReadonlySet<string>,
): ProviderState {
  if (!credentialed.has(provider)) return 'unusable';
  if (row === undefined) return 'unknown';
  if (row.circuitState === 'open' || !row.isHealthy) return 'unhealthy';
  if (row.lastSuccess !== null) return 'healthy';
  if (row.lastFailure !== null) return 'unhealthy';
  return 'unknown';
}

/**
 * Every configured provider/model pair, deduplicated.
 *
 * `TIER_MODEL_MAPPINGS` lists a pair once per TIER that routes to it, so the
 * same pair appears many times over — 119 listings across 14 tiers reduce to 58
 * distinct pairs. Counting the listings would report a number more than twice
 * the truth, and it would move whenever a tier was added without a single new
 * provider existing.
 */
function configuredPairs(
  mappings: Readonly<Record<string, readonly { provider: string; modelId: string }[]>>,
): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const tier of Object.values(mappings)) {
    for (const mapping of tier) {
      pairs.set(`${mapping.provider}:${mapping.modelId}`, mapping.provider);
    }
  }
  return pairs;
}

/**
 * All three facts, or none of them.
 *
 * The reads hit the same Postgres, so one failing means the others are not
 * trustworthy either — and a summary built from health rows with the credential
 * half missing would report every provider `unusable`, which is a far more
 * alarming lie than the one this endpoint exists to remove. Letting the whole
 * thing throw hands both callers their existing "could not reach the providers"
 * branch.
 */
async function summariseProviders(): Promise<ProviderSummary> {
  const [mappings, providers, credentialed] = await Promise.all([
    getTierMappings(),
    getAllProviderHealth(),
    providersWithUsableCredentials(),
  ]);

  // Telemetry indexed by the same key the configured census walks. A miss is a
  // pair nothing has recorded, not a pair that does not exist.
  const rows = new Map(providers.map((row) => [`${row.provider}:${row.modelId}`, row]));

  const summary: ProviderSummary = { ...NO_PROVIDERS };
  for (const [key, provider] of configuredPairs(mappings)) {
    const row = rows.get(key);
    summary.total += 1;
    summary[classifyProvider(provider, row, credentialed)] += 1;
    if (row?.circuitState === 'open') summary.openCircuits += 1;
  }
  return summary;
}

async function getHealthSnapshot() {
  if (healthCache && healthCache.expiry > Date.now()) {
    return healthCache.data;
  }

  const postgresReady = await isPostgresReady();

  let providersSummary = NO_PROVIDERS;
  let providersReachable = false;
  try {
    providersSummary = await summariseProviders();
    providersReachable = true;
  } catch {
    // Gateway unreachable — don't penalize health status
  }

  const mem = process.memoryUsage();
  const redisStatus = isQueueActive() ? 'connected' : 'unavailable';
  const relay = relayConnectivity();

  // Only require healthy providers if we could actually reach the gateway.
  // `relay` degrades the snapshot only when it is `unreachable`, which cannot
  // happen while the cutover flag is off — so the relay term is the one it has
  // always been on every deployment that exists.
  //
  // `providersSummary.healthy` is the term that changed: it now counts only
  // providers with a credential AND a recorded success, so no arrangement of
  // never-called defaults can satisfy this expression.
  const isHealthy =
    postgresReady && (!providersReachable || providersSummary.healthy > 0) && relay !== 'unreachable';

  const snapshot = {
    status: isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    postgres: postgresReady ? 'connected' : 'unavailable',
    redis: redisStatus,
    relay,
    /**
     * Whether this process has what it needs to reach Kaana.
     *
     * A DIFFERENT question from `relay`, which reports the cutover flag and
     * therefore reads `disabled` on every deployment that exists — including
     * the ones where Kaana is serving every background derivation right now.
     * An operator reading `relay: disabled` beside a working Kaana concluded
     * the opposite of the truth, which is what this field exists to stop.
     *
     * `configured`, not `serving`: nothing is probed to answer it, and a field
     * that claimed reachability without a request would be the same mistake in
     * the other direction.
     */
    kaana: unsetKaanaVariables().length === 0 ? 'configured' : 'not_configured',
    providers: providersSummary,
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),       // MB
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024), // MB
    },
  };

  healthCache = { data: snapshot, expiry: Date.now() + HEALTH_CACHE_TTL_MS };
  return snapshot;
}

// Full health check with details
router.get('/', async (_req, res) => {
  try {
    const snapshot = await getHealthSnapshot() as { status: string };
    const statusCode = snapshot.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(snapshot);
  } catch (error: unknown) {
    log.general.error({ err: error }, 'Health check failed');
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    });
  }
});

// Liveness probe: process is running -> 200. Consults NOTHING; see the module comment.
router.get('/live', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

// Readiness probe: can THIS TASK serve the API. One condition — Postgres
// answers a real query through this task's own pool. Used by load balancers to
// decide if this instance should receive traffic.
router.get('/ready', async (_req, res) => {
  if (!(await isPostgresReady())) {
    return res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
  }

  // Neither provider state nor Relay is consulted. Both are reported — Relay
  // right here in the body — and neither may deregister a task. See the module
  // comment for the test that decides which conditions belong in this answer.
  res.status(200).json({ status: 'ready', relay: relayConnectivity() });
});

export default router;
