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

/** Postgres answers, the queue is up, the gateway has a healthy provider. */
function mockDependencies(postgresReady: boolean): void {
  vi.doMock('../../db/index.js', () => ({
    getDb: () => ({
      execute: () =>
        postgresReady ? Promise.resolve([]) : Promise.reject(new Error('pool exhausted')),
    }),
  }));
  vi.doMock('../../lib/task-queue.js', () => ({ isQueueActive: () => true }));
  vi.doMock('../../lib/gateway-client.js', () => ({
    getAllProviderHealth: () =>
      Promise.resolve([{ isHealthy: true, circuitState: 'closed' }]),
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
  { postgresReady = true, relay = 'no observation' as RelayState } = {},
): Promise<Probe> {
  vi.resetModules();
  mockDependencies(postgresReady);

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

describe('/health/ready acts on Relay connectivity, after the cutover', () => {
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

  it('is NOT ready while a circuit is open', async () => {
    // The assertion the source-text guard could not make. An inverted condition
    // returns 200 here and fails this test by status code alone.
    vi.stubEnv(RELAY_CLIENT_ENABLED_ENV, 'true');
    const { status, body } = await probe('/health/ready', { relay: UNAVAILABLE });
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'not_ready', reason: 'relay_unreachable' });
  });

  it('is ready again once the cooldown lapses, without anything clearing it', async () => {
    vi.stubEnv(RELAY_CLIENT_ENABLED_ENV, 'true');
    const { status, body } = await probe('/health/ready', { relay: LAPSED });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ready', relay: 'unknown' });
  });

  it('reports the database failure ahead of Relay, because it is the older signal', async () => {
    // Order is behaviour: an operator reading `relay_unreachable` would go and
    // look at Relay while the actual fault was Postgres.
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
