import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoutingTarget } from '@oxyhq/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AliaInferenceCall, AliaInferenceContext } from '../product-seam.js';
import {
  createRelayInferenceClient,
  type RelayClientConfig,
  type RelayServiceCredential,
  type RelayTransport,
  type RelayTransportRequest,
} from '../relay-client.js';
import {
  relayBlocksReadiness,
  relayConnectivity,
  reportRelayReachable,
  reportRelayUnavailableUntil,
} from '../relay-connectivity.js';
import { RELAY_CLIENT_ENABLED_ENV } from '../relay-cutover.js';
import { assertAllowedRelayOrigin } from '../relay-endpoint.js';
import type { RelayRequestPayload } from '../relay-request.js';

/** An approved Relay origin, branded through the one function that produces one. */
const ENDPOINT = assertAllowedRelayOrigin('https://api.oxy.so', 'development');

/**
 * Epic #139 workstream 8 — *"Make Relay connectivity explicit in
 * health/readiness checks."*
 *
 * Three properties, and the first is the one that makes this safe to land while
 * the product is still served by the in-process provider path:
 *
 *  1. **With the cutover flag off, readiness is what it was.** `'disabled'`
 *     neither degrades `/health` nor blocks `/health/ready`, so the status code
 *     either route returns today is unchanged and only the body gains a field.
 *  2. **The signal has a real producer.** A registry nothing writes to is green
 *     and inert, so the client's own circuit is driven here through the real
 *     constructor and the state is read afterwards.
 *  3. **The route consumes it.** A producer with no consumer is the same failure
 *     from the other end, so `routes/health.ts` is asserted to call both
 *     functions — the entrypoint, not just the mechanism.
 */

const HEALTH_ROUTE = path.resolve(
  fileURLToPath(new URL('../../../routes/health.ts', import.meta.url)),
);

const ENABLED: NodeJS.ProcessEnv = { [RELAY_CLIENT_ENABLED_ENV]: 'true' };
const DISABLED: NodeJS.ProcessEnv = {};

beforeEach(() => {
  // The registry is process state, so each test starts from the boot state: no
  // sample, no recorded unavailability.
  reportRelayUnavailableUntil(0);
});

/* -------------------------------------------------------------------------- */
/*  1. The flag-off path is unchanged                                          */
/* -------------------------------------------------------------------------- */

describe('with the cutover flag off Relay does not enter the health answer', () => {
  it('reports disabled whatever the samples say', () => {
    reportRelayReachable();
    expect(relayConnectivity(DISABLED, 1_000)).toBe('disabled');
    reportRelayUnavailableUntil(9_999_999);
    expect(relayConnectivity(DISABLED, 1_000)).toBe('disabled');
    // The control: the same samples under the flag DO change the answer, so
    // `disabled` is about the flag and not about a registry nothing wrote to.
    expect(relayConnectivity(ENABLED, 1_000)).toBe('unreachable');
  });

  it('never blocks readiness', () => {
    reportRelayUnavailableUntil(9_999_999);
    expect(relayBlocksReadiness(DISABLED, 1_000)).toBe(false);
    expect(relayBlocksReadiness(ENABLED, 1_000)).toBe(true);
  });

  it('is off for every value that is not exactly the literal true', () => {
    reportRelayUnavailableUntil(9_999_999);
    for (const value of ['1', 'TRUE', 'True', 'yes', '', ' true']) {
      expect(relayConnectivity({ [RELAY_CLIENT_ENABLED_ENV]: value }, 1_000)).toBe('disabled');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  The states, and the one that must not block a cold task                    */
/* -------------------------------------------------------------------------- */

describe('the four states are distinguished, and only one blocks readiness', () => {
  it('a cold task is unknown and stays in rotation', () => {
    // The deadlock this prevents: a task out of rotation receives no request, so
    // it can never acquire the evidence that would put it back in. "No evidence"
    // must therefore be ready.
    expect(relayConnectivity(ENABLED, 1_000)).toBe('unknown');
    expect(relayBlocksReadiness(ENABLED, 1_000)).toBe(false);
  });

  it('a completed call makes it reachable', () => {
    reportRelayReachable();
    expect(relayConnectivity(ENABLED, 1_000)).toBe('reachable');
    expect(relayBlocksReadiness(ENABLED, 1_000)).toBe(false);
  });

  it('an open circuit makes it unreachable until the cooldown lapses', () => {
    reportRelayUnavailableUntil(5_000);
    expect(relayConnectivity(ENABLED, 4_999)).toBe('unreachable');
    // Self-expiring: nothing has to clear it, so a stale sample cannot pin a
    // task out of rotation forever.
    expect(relayConnectivity(ENABLED, 5_000)).toBe('unknown');
    expect(relayBlocksReadiness(ENABLED, 5_000)).toBe(false);
  });

  it('a success closes a recorded unavailability immediately', () => {
    reportRelayUnavailableUntil(5_000);
    reportRelayReachable();
    expect(relayConnectivity(ENABLED, 1_000)).toBe('reachable');
  });
});

/* -------------------------------------------------------------------------- */
/*  2. The client is the producer                                              */
/* -------------------------------------------------------------------------- */

const DEFAULT_TARGET: RoutingTarget = { kind: 'routing_profile', routingProfile: 'auto' };

const CREDENTIAL: RelayServiceCredential = {
  getServiceToken: () => Promise.resolve('oxy-service-token-synthetic'),
  invalidateServiceToken: () => undefined,
};

/** A transport that answers with one terminal event of the caller's choosing. */
function answering(event: Record<string, unknown>): RelayTransport {
  return {
    send: (_input: RelayTransportRequest): Promise<AsyncIterable<unknown>> =>
      Promise.resolve(
        (async function* () {
          yield event;
        })(),
      ),
  };
}

function context(): AliaInferenceContext {
  return {
    surface: 'chat',
    visibility: 'user_turn',
    caller: { oxyUserId: null, billing: 'platform_cost', viaApiKey: false },
    model: { kind: 'product_default' },
    conversationId: null,
    fallbackPolicy: null,
    budget: { connectMs: 500, firstTokenMs: 500, idleStreamMs: 500, totalMs: 5_000 },
    onDisconnect: 'abort',
  };
}

const CALL: AliaInferenceCall<RelayRequestPayload> = {
  context: context(),
  payload: {
    modality: 'text',
    input: { format: 'messages', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    sampling: {},
    tools: [],
    client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions' },
  },
};

function client(over: Partial<RelayClientConfig>): ReturnType<typeof createRelayInferenceClient> {
  return createRelayInferenceClient({
    enabled: true,
    transport: answering({}),
    credential: CREDENTIAL,
    endpoint: ENDPOINT,
    principal: {
      billing: { accountId: 'acct_alia' },
      applicationId: 'app_alia',
      credentialId: 'cred_alia_1',
      environment: 'production',
      inferenceScopes: ['inference:invoke'],
    },
    defaultTarget: DEFAULT_TARGET,
    routingPolicies: {},
    defaultRoutingPolicy: { routingPolicyId: 'alia-default', policyVersion: 7 },
    maxAttempts: 1,
    circuit: { failureThreshold: 1, cooldownMs: 30_000 },
    ...over,
  });
}

async function drain(built: ReturnType<typeof createRelayInferenceClient>): Promise<void> {
  for await (const _event of built.stream(CALL, new AbortController().signal)) {
    // Drained.
  }
}

describe('the Relay client is what reports connectivity (#139 ws8)', () => {
  it('a completed call reports reachable, through the real client', async () => {
    const done = [
      {
        schemaVersion: 1,
        type: 'start',
        requestId: 'relay-req-1',
        sequence: 0,
        generationId: 'gen-1',
        resolvedModelReference: 'anthropic/claude',
        servingProvider: 'oxy',
        startedAt: '2026-08-17T00:00:00.000Z',
      },
      {
        schemaVersion: 1,
        type: 'done',
        requestId: 'relay-req-1',
        sequence: 1,
        generationId: 'gen-1',
        finishReason: 'stop',
        receiptId: 'rcpt-1',
        completedAt: '2026-08-17T00:00:01.000Z',
      },
    ];
    let index = 0;
    await drain(
      client({
        transport: {
          send: () =>
            Promise.resolve(
              (async function* () {
                while (index < done.length) yield done[index++];
              })(),
            ),
        },
      }),
    );

    expect(relayConnectivity(ENABLED, 1_000)).toBe('reachable');
  });

  it('an availability failure that opens the circuit reports unreachable', async () => {
    await drain(
      client({
        // `failureThreshold: 1`, so one availability failure opens the circuit.
        now: () => 1_000,
        transport: answering({
          schemaVersion: 1,
          type: 'error',
          requestId: 'relay-req-2',
          sequence: 0,
          error: {
            schemaVersion: 1,
            code: 'service_unavailable',
            message: 'relay is not answering',
            retryable: true,
            requestId: 'relay-req-2',
          },
        }),
      }),
    );

    // The cooldown is 30s from the injected clock's 1_000.
    expect(relayConnectivity(ENABLED, 2_000)).toBe('unreachable');
    expect(relayBlocksReadiness(ENABLED, 2_000)).toBe(true);
    expect(relayConnectivity(ENABLED, 31_001)).toBe('unknown');
  });

  it('a failure that is NOT about availability leaves connectivity alone', async () => {
    // `no_route_available` is a correct, immediate answer about one request and
    // says nothing about whether Relay is reachable. A client that reported it
    // as unreachable would let one badly configured caller take the whole task
    // out of rotation.
    await drain(
      client({
        now: () => 1_000,
        transport: answering({
          schemaVersion: 1,
          type: 'error',
          requestId: 'relay-req-3',
          sequence: 0,
          error: {
            schemaVersion: 1,
            code: 'no_route_available',
            message: 'nothing serves that',
            retryable: false,
            requestId: 'relay-req-3',
          },
        }),
      }),
    );

    expect(relayConnectivity(ENABLED, 2_000)).toBe('unknown');
  });
});

/* -------------------------------------------------------------------------- */
/*  3. The health route consumes it                                            */
/* -------------------------------------------------------------------------- */

describe('the health route reads the signal (#139 ws8)', () => {
  const source = readFileSync(HEALTH_ROUTE, 'utf8');

  it('read the real health route, not an empty or unrelated file', () => {
    // The vacuity floor: without this, every assertion below passes on a bad
    // read for reasons that have nothing to do with the wiring.
    expect(source.length).toBeGreaterThan(3_000);
    expect(source).toContain("router.get('/ready'");
    expect(source).toContain("router.get('/live'");
  });

  it('puts Relay in the snapshot and in the readiness decision', () => {
    // A mechanism can be green and inert; this is the assertion that the
    // ENTRYPOINT calls it. Both functions, because they answer different
    // questions and the route needs both.
    expect(source).toContain('relayConnectivity()');
    expect(source).toContain('relayBlocksReadiness()');
    expect(source).toContain("reason: 'relay_unreachable'");
  });

  it('leaves the liveness probe consulting nothing', () => {
    /**
     * `/health/live` is what the `oxy-alia` target group polls today, so a
     * dependency in it is a dependency that can get a task KILLED. The Relay
     * signal has no business in a liveness answer, and this asserts the handler
     * body between `'/live'` and the next route is still the unconditional one.
     */
    const liveStart = source.indexOf("router.get('/live'");
    const readyStart = source.indexOf("router.get('/ready'");
    expect(liveStart).toBeGreaterThan(0);
    expect(readyStart).toBeGreaterThan(liveStart);
    const liveHandler = source.slice(liveStart, readyStart);
    expect(liveHandler).toContain("status: 'alive'");
    for (const forbidden of ['relayConnectivity', 'relayBlocksReadiness', 'await']) {
      expect(liveHandler, `/live consults ${forbidden}`).not.toContain(forbidden);
    }
  });
});
