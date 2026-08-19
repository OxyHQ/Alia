import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import {
  getAllProviderHealth,
  providersWithUsableCredentials,
  type HealthMetrics,
} from '../lib/gateway-client.js';
import { relayBlocksReadiness, relayConnectivity } from '../lib/inference/relay-connectivity.js';
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
 * The four partition the rows exactly; `openCircuits` stays the overlapping
 * detail it has always been. No provider NAME appears in the response — these
 * are counts, and `/health` is public and unauthenticated.
 *
 * ### `healthy` deliberately has no staleness window
 *
 * A success from six months ago still counts. The tempting refinement — expire
 * `last_success` after some window — makes the endpoint a function of TRAFFIC:
 * a quiet night would degrade the service and, after the target group moves,
 * take tasks out of rotation for having been idle. Absence of a credential is
 * the durable fact worth reporting, and it is reported.
 *
 * ### Readiness moves only on OBSERVED failure
 *
 * `/health/ready` keeps its provider gate but narrows what can trip it, for the
 * reason the Relay section above gives and for one more: `provider_health` and
 * `provider_keys` are single tables shared by every task, so `unusable` and
 * `unknown` are FLEET-WIDE facts. Failing readiness on them would take every
 * task out of rotation at once — including the routes an operator would use to
 * install the missing credential — and no task out of rotation can acquire the
 * evidence that would put it back. `/health` says degraded, loudly, and that is
 * the right place for a fact a deploy has to fix.
 *
 * This is also why the change cannot cause an outage on the target-group move:
 * with no failure ever recorded, the readiness gate is exactly as unreachable
 * after this change as before it, which `__tests__/health-route.test.ts`
 * asserts as a status code rather than claiming here.
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

/** The four states a `provider_health` row can be in. They partition the rows. */
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
 * Which of the four a row is in. The order of the tests IS the precedence; see
 * the module comment for why each one sits where it does.
 *
 * `lastSuccess` arrives as a `Date` from Postgres and as a string over the
 * gateway's JSON, so it is tested for presence rather than read.
 */
function classifyProvider(row: HealthMetrics, credentialed: ReadonlySet<string>): ProviderState {
  if (!credentialed.has(row.provider)) return 'unusable';
  if (row.circuitState === 'open' || !row.isHealthy) return 'unhealthy';
  if (row.lastSuccess !== null) return 'healthy';
  if (row.lastFailure !== null) return 'unhealthy';
  return 'unknown';
}

/**
 * Both facts, or neither.
 *
 * The two reads hit the same Postgres, so one failing means the other is not
 * trustworthy either — and a summary built from health rows with the credential
 * half missing would report every provider `unusable`, which is a far more
 * alarming lie than the one this change removes. Letting the whole thing throw
 * hands both callers their existing "could not reach the providers" branch.
 */
async function summariseProviders(): Promise<ProviderSummary> {
  const [providers, credentialed] = await Promise.all([
    getAllProviderHealth(),
    providersWithUsableCredentials(),
  ]);

  const summary: ProviderSummary = { ...NO_PROVIDERS, total: providers.length };
  for (const provider of providers) {
    summary[classifyProvider(provider, credentialed)] += 1;
    if (provider.circuitState === 'open') summary.openCircuits += 1;
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

// Readiness probe: Postgres answers a real query, Relay is not observed
// unreachable, and no OBSERVED provider failure is unanswered by a success.
// Used by load balancers to decide if this instance should receive traffic.
router.get('/ready', async (_req, res) => {
  if (!(await isPostgresReady())) {
    return res.status(503).json({ status: 'not_ready', reason: 'database_unavailable' });
  }

  /**
   * Only an OBSERVED open circuit takes a task out of rotation, and only after
   * the cutover. A cold task reports `unknown` and stays ready on purpose: a
   * task out of rotation receives no request, so it could never acquire the
   * evidence that would put it back in. See `lib/inference/relay-connectivity.ts`.
   */
  if (relayBlocksReadiness()) {
    return res.status(503).json({ status: 'not_ready', reason: 'relay_unreachable' });
  }

  try {
    /**
     * Only a provider the fleet has WATCHED fail takes a task out of rotation.
     *
     * `unusable` and `unknown` are fleet-wide facts read from tables every task
     * shares, so acting on them here would empty the load balancer in one step
     * and lock out the routes that fix the cause. `/health` reports them; this
     * probe does not act on them. The module comment carries the full argument.
     */
    const providers = await summariseProviders();
    if (providers.healthy === 0 && providers.unhealthy > 0) {
      return res.status(503).json({ status: 'not_ready', reason: 'no_healthy_providers' });
    }
  } catch {
    // If we can't check providers, still consider ready if Postgres is up
  }

  res.status(200).json({ status: 'ready', relay: relayConnectivity() });
});

export default router;
