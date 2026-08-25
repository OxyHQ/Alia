import { beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only, so it is erased before the `../../db/index.js` mock below applies.
import type { getDb as getDbSignature } from '../../db/index.js';

/**
 * What the boot path starts, in what order, and that it all stops again.
 *
 * ## Why this file exists rather than another census of `src/index.ts`
 *
 * These nine statements used to live in `startBackgroundServices()` inside
 * `src/index.ts`, which nothing imports because importing it opens a socket. So
 * the only available evidence was source text — and source text is what could
 * not see the defect that mattered: the function was reached ONLY from
 * `connectDB().then(...)`, a MongoDB connection whose URI left the task
 * definition at the decommission, so it retried forever and the trigger engine,
 * the dispatcher, both queues and the container pool never started at all. The
 * text of every one of those calls was correct the whole time.
 *
 * A census cannot fail on "the caller never fires". This can: every assertion
 * below runs the real `startBackgroundServices`, so deleting a call or moving it
 * behind a condition that is false turns one of these red.
 *
 * The collaborators are doubled because starting them for real would open a
 * Redis connection, elect a leader against Postgres and reach a Docker host.
 * What is under test is the ORCHESTRATION — which of them run, and when — and
 * that is exactly what a double can carry honestly.
 */

const order: string[] = [];

/** Records the call, in order, and resolves. */
const traced = (name: string) => vi.fn(() => { order.push(name); return Promise.resolve(); });
/** Records the call, in order, and returns nothing — for the synchronous starters. */
const tracedSync = (name: string) => vi.fn(() => { order.push(name); });

const warmupGatewayClient = traced('warmupGatewayClient');
const syncZeroEval = traced('syncZeroEval');
const startTriggerEngine = tracedSync('startTriggerEngine');
const stopTriggerEngine = traced('stopTriggerEngine');
const dispatcherStart = tracedSync('dispatcher.start');
const dispatcherStop = traced('dispatcher.stop');
const initTaskQueue = traced('initTaskQueue');
const startWorker = traced('startWorker');
const shutdownTaskQueue = traced('shutdownTaskQueue');
const initShowQueue = traced('initShowQueue');
const startShowWorker = traced('startShowWorker');
const shutdownShowQueue = traced('shutdownShowQueue');
const containerPoolInitialize = traced('containerPool.initialize');
const shutdownContainerPool = traced('shutdownContainerPool');
const failOrphanedAudioJobs = vi.fn(() => { order.push('failOrphanedAudioJobs'); return Promise.resolve(0); });
const reclaimOrphanedAgentSessions = vi.fn(() => { order.push('reclaimOrphanedAgentSessions'); return Promise.resolve(0); });

/** A sentinel, so the audio-job cleanup can be asserted to receive the handle `getDb()` returned. */
const DB_HANDLE = Symbol('db') as unknown as ReturnType<typeof getDbSignature>;
const getDb = vi.fn((): ReturnType<typeof getDbSignature> => DB_HANDLE);

vi.mock('../gateway-client.js', () => ({ warmupGatewayClient }));
vi.mock('../../scripts/sync-zeroeval.js', () => ({ syncZeroEval }));
vi.mock('../trigger-engine.js', () => ({ startTriggerEngine, stopTriggerEngine }));
vi.mock('../crowdsource/dispatcher.js', () => ({
  moderationOutboxDispatcher: { start: dispatcherStart, stop: dispatcherStop },
}));
vi.mock('../task-queue.js', () => ({ initTaskQueue, startWorker, shutdownTaskQueue }));
vi.mock('../show/show-queue.js', () => ({ initShowQueue, startShowWorker, shutdownShowQueue }));
vi.mock('../sandbox/container-pool.js', () => ({
  getContainerPool: () => ({ initialize: containerPoolInitialize }),
  shutdownContainerPool,
}));
vi.mock('../../db/notifications/audioJobRepository.js', () => ({ failOrphanedAudioJobs }));
vi.mock('../agent/session-handoff.js', () => ({ reclaimOrphanedAgentSessions }));
vi.mock('../../db/index.js', () => ({ getDb }));
vi.mock('../logger.js', () => ({
  log: { general: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const { startBackgroundServices, stopBackgroundServices } = await import('../background-services.js');

/** Let the `.then(...)` continuations of the fire-and-forget starters settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
});

describe('startBackgroundServices', () => {
  it('starts every background service, with no database connection to wait on', async () => {
    startBackgroundServices();
    await settle();

    /*
     * Named individually rather than compared against `order`, so a failure says
     * WHICH service stopped starting. The list is the whole population: the
     * ordering assertion below is what stops a service being added here and
     * quietly left out of the source.
     */
    expect(warmupGatewayClient).toHaveBeenCalledTimes(1);
    expect(syncZeroEval).toHaveBeenCalledTimes(1);
    expect(startTriggerEngine).toHaveBeenCalledTimes(1);
    expect(dispatcherStart).toHaveBeenCalledTimes(1);
    expect(initTaskQueue).toHaveBeenCalledTimes(1);
    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(containerPoolInitialize).toHaveBeenCalledTimes(1);
    expect(failOrphanedAudioJobs).toHaveBeenCalledTimes(1);
    expect(reclaimOrphanedAgentSessions).toHaveBeenCalledTimes(1);
    expect(initShowQueue).toHaveBeenCalledTimes(1);
    expect(startShowWorker).toHaveBeenCalledTimes(1);
  });

  it('returns synchronously — a starter may not stand between the process and /health/live', () => {
    /*
     * The direction that is dangerous rather than merely wrong. This is called
     * from inside the `server.listen` callback; a version that awaited its
     * starters would hold the event loop on Redis, a leader election and a
     * Docker host before the process could answer a liveness probe, and the ALB
     * kills a task that fails one. `void` is the return type, so what is
     * asserted is that nothing here is awaited: every starter's promise is still
     * pending when the call returns.
     */
    initTaskQueue.mockImplementationOnce(() => { order.push('initTaskQueue'); return new Promise(() => {}); });
    initShowQueue.mockImplementationOnce(() => { order.push('initShowQueue'); return new Promise(() => {}); });
    containerPoolInitialize.mockImplementationOnce(() => {
      order.push('containerPool.initialize');
      return new Promise(() => {});
    });

    expect(startBackgroundServices()).toBeUndefined();
    // It got all the way to the last statement despite three starters that never settle.
    expect(initShowQueue).toHaveBeenCalledTimes(1);
  });

  it('starts them in the order the boot path has always used', async () => {
    startBackgroundServices();
    await settle();

    /*
     * The full sequence, exact. An extraction from `src/index.ts` is only safe
     * if it changes nothing about WHEN anything happens, and "I moved the lines
     * unchanged" is a claim about a diff, not about behaviour.
     *
     * The two workers appear after every synchronous starter because they hang
     * off `initTaskQueue().then(...)` and `initShowQueue().then(...)`, which is
     * the pre-existing shape and not an accident of the doubles.
     */
    expect(order).toEqual([
      'warmupGatewayClient',
      'syncZeroEval',
      'startTriggerEngine',
      'dispatcher.start',
      'initTaskQueue',
      'containerPool.initialize',
      'failOrphanedAudioJobs',
      'reclaimOrphanedAgentSessions',
      'initShowQueue',
      'startWorker',
      'startShowWorker',
    ]);
  });

  it('hands the audio-job cleanup the real Postgres handle', async () => {
    startBackgroundServices();
    await settle();

    // `failOrphanedAudioJobs(getDb())` — the argument is the whole point of the
    // call, and a version passing nothing would still satisfy "was called".
    expect(getDb).toHaveBeenCalledTimes(1);
    expect(failOrphanedAudioJobs).toHaveBeenCalledWith(DB_HANDLE);
  });

  it('survives a starter that rejects, and starts the rest', async () => {
    /*
     * The positive control for every "it starts" assertion above: they would all
     * pass equally on a version that started nothing after the first failure.
     * `warmupGatewayClient` is first, and a gateway that is not configured is an
     * ordinary state — it must not be able to take the queues down with it.
     */
    warmupGatewayClient.mockImplementationOnce(() => {
      order.push('warmupGatewayClient');
      return Promise.reject(new Error('gateway unreachable'));
    });

    startBackgroundServices();
    await settle();

    expect(startTriggerEngine).toHaveBeenCalledTimes(1);
    expect(dispatcherStart).toHaveBeenCalledTimes(1);
    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(startShowWorker).toHaveBeenCalledTimes(1);
  });
});

describe('stopBackgroundServices', () => {
  it('stops everything the start half started', async () => {
    await stopBackgroundServices();

    expect(stopTriggerEngine).toHaveBeenCalledTimes(1);
    expect(dispatcherStop).toHaveBeenCalledTimes(1);
    expect(shutdownTaskQueue).toHaveBeenCalledTimes(1);
    expect(shutdownShowQueue).toHaveBeenCalledTimes(1);
    expect(shutdownContainerPool).toHaveBeenCalledTimes(1);
  });

  it('leaves nothing running that it started', async () => {
    /**
     * The pairing, asserted as a pairing rather than as two lists that happen to
     * agree today. A service added to the start half and forgotten in the stop
     * half leaks on every SIGTERM — and for the trigger engine specifically it
     * strands the leadership lease, so no OTHER task schedules anything until
     * the lease TTL expires.
     *
     * The map is the seam: adding a starter without a stopper is a compile-time
     * hole here only if the author edits this map, so the SOURCE is read too —
     * an unmapped starter fails the last assertion.
     */
    const STOPPER_FOR: Readonly<Record<string, string>> = {
      startTriggerEngine: 'stopTriggerEngine',
      'dispatcher.start': 'dispatcher.stop',
      initTaskQueue: 'shutdownTaskQueue',
      initShowQueue: 'shutdownShowQueue',
      'containerPool.initialize': 'shutdownContainerPool',
      // Fire-and-forget work with no running resource behind it. Each of these
      // is one call that settles; there is nothing left to stop.
      warmupGatewayClient: '',
      syncZeroEval: '',
      failOrphanedAudioJobs: '',
      reclaimOrphanedAgentSessions: '',
      startWorker: 'shutdownTaskQueue',
      startShowWorker: 'shutdownShowQueue',
    };

    startBackgroundServices();
    await settle();
    const started = [...order];
    // Vacuity floor: an empty `started` would make the loop below assert nothing.
    expect(started.length).toBe(11);

    order.length = 0;
    await stopBackgroundServices();
    const stopped = new Set(order);

    const leaked = started.filter((name) => {
      const stopper = STOPPER_FOR[name];
      if (stopper === undefined) return true;
      return stopper !== '' && !stopped.has(stopper);
    });
    expect(leaked).toEqual([]);
  });

  it('releases the leader lease before draining the queues', async () => {
    /*
     * Order matters in one direction here: the trigger engine must let go of its
     * leadership lease and the dispatcher must stop CLAIMING work before the
     * queues drain, or the last batch is claimed by a task that is already
     * shutting down and has to wait out its lease to be reclaimed.
     */
    await stopBackgroundServices();

    expect(order).toEqual([
      'stopTriggerEngine',
      'dispatcher.stop',
      'shutdownTaskQueue',
      'shutdownShowQueue',
      'shutdownContainerPool',
    ]);
  });
});
