import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoutingTarget } from '@oxyhq/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AliaInferenceCall, AliaInferenceContext } from '../product-seam.js';
import {
  createKaanaInferenceClient,
  type KaanaClientConfig,
  type KaanaServiceCredential,
  type KaanaTransport,
  type KaanaTransportRequest,
} from '../kaana-client.js';
import {
  kaanaConnectivity,
  reportKaanaReachable,
  reportKaanaUnavailableUntil,
} from '../kaana-connectivity.js';
import { KAANA_CLIENT_ENABLED_ENV } from '../kaana-cutover.js';
import { assertAllowedKaanaOrigin } from '../kaana-endpoint.js';
import type { KaanaRequestPayload } from '../kaana-request.js';

/** An approved Kaana origin, branded through the one function that produces one. */
const ENDPOINT = assertAllowedKaanaOrigin('https://api.oxy.so', 'development');

/**
 * Epic #139 workstream 8 — *"Make Kaana connectivity explicit in
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

const ENABLED: NodeJS.ProcessEnv = { [KAANA_CLIENT_ENABLED_ENV]: 'true' };
const DISABLED: NodeJS.ProcessEnv = {};

beforeEach(() => {
  // The registry is process state, so each test starts from the boot state: no
  // sample, no recorded unavailability.
  reportKaanaUnavailableUntil(0);
});

/* -------------------------------------------------------------------------- */
/*  1. The flag-off path is unchanged                                          */
/* -------------------------------------------------------------------------- */

describe('with the cutover flag off Kaana does not enter the health answer', () => {
  it('reports disabled whatever the samples say', () => {
    reportKaanaReachable();
    expect(kaanaConnectivity(DISABLED, 1_000)).toBe('disabled');
    reportKaanaUnavailableUntil(9_999_999);
    expect(kaanaConnectivity(DISABLED, 1_000)).toBe('disabled');
    // The control: the same samples under the flag DO change the answer, so
    // `disabled` is about the flag and not about a registry nothing wrote to.
    expect(kaanaConnectivity(ENABLED, 1_000)).toBe('unreachable');
  });

  it('reports disabled even with an unavailability recorded', () => {
    reportKaanaUnavailableUntil(9_999_999);
    expect(kaanaConnectivity(DISABLED, 1_000)).toBe('disabled');
    // The control, so `disabled` is the flag rather than an unwritten registry.
    expect(kaanaConnectivity(ENABLED, 1_000)).toBe('unreachable');
  });

  it('is off for every value that is not exactly the literal true', () => {
    reportKaanaUnavailableUntil(9_999_999);
    for (const value of ['1', 'TRUE', 'True', 'yes', '', ' true']) {
      expect(kaanaConnectivity({ [KAANA_CLIENT_ENABLED_ENV]: value }, 1_000)).toBe('disabled');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  The states, and the one that must not block a cold task                    */
/* -------------------------------------------------------------------------- */

describe('the four states are distinguished, and none of them blocks readiness', () => {
  it('a cold task is unknown and stays in rotation', () => {
    // The deadlock this prevents: a task out of rotation receives no request, so
    // it can never acquire the evidence that would put it back in. "No evidence"
    // must therefore be ready.
    expect(kaanaConnectivity(ENABLED, 1_000)).toBe('unknown');
  });

  it('a completed call makes it reachable', () => {
    reportKaanaReachable();
    expect(kaanaConnectivity(ENABLED, 1_000)).toBe('reachable');
  });

  it('an open circuit makes it unreachable until the cooldown lapses', () => {
    reportKaanaUnavailableUntil(5_000);
    expect(kaanaConnectivity(ENABLED, 4_999)).toBe('unreachable');
    // Self-expiring: nothing has to clear it, so a stale sample cannot pin a
    // task out of rotation forever.
    expect(kaanaConnectivity(ENABLED, 5_000)).toBe('unknown');
  });

  it('a success closes a recorded unavailability immediately', () => {
    reportKaanaUnavailableUntil(5_000);
    reportKaanaReachable();
    expect(kaanaConnectivity(ENABLED, 1_000)).toBe('reachable');
  });
});

/* -------------------------------------------------------------------------- */
/*  2. The client is the producer                                              */
/* -------------------------------------------------------------------------- */

const DEFAULT_TARGET: RoutingTarget = { kind: 'routing_profile', routingProfile: 'auto' };

const CREDENTIAL: KaanaServiceCredential = {
  getServiceToken: () => Promise.resolve('oxy-service-token-synthetic'),
  invalidateServiceToken: () => undefined,
};

/** A transport that answers with one terminal event of the caller's choosing. */
function answering(event: Record<string, unknown>): KaanaTransport {
  return {
    send: (_input: KaanaTransportRequest): Promise<AsyncIterable<unknown>> =>
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

const CALL: AliaInferenceCall<KaanaRequestPayload> = {
  context: context(),
  payload: {
    modality: 'text',
    input: { format: 'messages', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    sampling: {},
    tools: [],
    client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions' },
  },
};

function client(over: Partial<KaanaClientConfig>): ReturnType<typeof createKaanaInferenceClient> {
  return createKaanaInferenceClient({
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

async function drain(built: ReturnType<typeof createKaanaInferenceClient>): Promise<void> {
  for await (const _event of built.stream(CALL, new AbortController().signal)) {
    // Drained.
  }
}

describe('the Kaana client is what reports connectivity (#139 ws8)', () => {
  it('a completed call reports reachable, through the real client', async () => {
    const done = [
      {
        schemaVersion: 1,
        type: 'start',
        requestId: 'kaana-req-1',
        sequence: 0,
        generationId: 'gen-1',
        resolvedModelReference: 'anthropic/claude',
        servingProvider: 'oxy',
        startedAt: '2026-08-17T00:00:00.000Z',
      },
      {
        schemaVersion: 1,
        type: 'done',
        requestId: 'kaana-req-1',
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

    expect(kaanaConnectivity(ENABLED, 1_000)).toBe('reachable');
  });

  it('an availability failure that opens the circuit reports unreachable', async () => {
    await drain(
      client({
        // `failureThreshold: 1`, so one availability failure opens the circuit.
        now: () => 1_000,
        transport: answering({
          schemaVersion: 1,
          type: 'error',
          requestId: 'kaana-req-2',
          sequence: 0,
          error: {
            schemaVersion: 1,
            code: 'service_unavailable',
            message: 'Kaana is not answering',
            retryable: true,
            requestId: 'kaana-req-2',
          },
        }),
      }),
    );

    // The cooldown is 30s from the injected clock's 1_000.
    expect(kaanaConnectivity(ENABLED, 2_000)).toBe('unreachable');
    expect(kaanaConnectivity(ENABLED, 31_001)).toBe('unknown');
  });

  it('a failure that is NOT about availability leaves connectivity alone', async () => {
    // `no_route_available` is a correct, immediate answer about one request and
    // says nothing about whether Kaana is reachable. A client that reported it
    // as unreachable would let one badly configured caller take the whole task
    // out of rotation.
    await drain(
      client({
        now: () => 1_000,
        transport: answering({
          schemaVersion: 1,
          type: 'error',
          requestId: 'kaana-req-3',
          sequence: 0,
          error: {
            schemaVersion: 1,
            code: 'no_route_available',
            message: 'nothing serves that',
            retryable: false,
            requestId: 'kaana-req-3',
          },
        }),
      }),
    );

    expect(kaanaConnectivity(ENABLED, 2_000)).toBe('unknown');
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

  it('puts Kaana in the snapshot, and gives it no power to deregister a task', () => {
    // A mechanism can be green and inert, so the first line is the assertion
    // that the ENTRYPOINT calls it at all.
    expect(source).toContain('kaanaConnectivity()');

    /**
     * The other two are the REMOVAL, frozen. `kaanaBlocksReadiness()` used to be
     * called here and `/health/ready` used to answer 503 `relay_unreachable`,
     * which deregistered every task at once the moment Kaana stopped answering
     * — Kaana being unreachable is not a per-task fact, however per-process the
     * observation is. The full argument is in `kaana-connectivity.ts` and in
     * `routes/health.ts`.
     *
     * A source-text assertion is the weak form and it is the right one HERE:
     * the behaviour is already pinned as status codes in
     * `routes/__tests__/health-route.test.ts`, and what this adds is that the
     * SYMBOL cannot quietly reappear in the route under a rewritten condition.
     */
    const readyStart = source.indexOf("router.get('/ready'");
    const readyEnd = source.indexOf('export default', readyStart);
    expect(readyStart).toBeGreaterThan(0);
    expect(readyEnd).toBeGreaterThan(readyStart);
    const readyHandler = source.slice(readyStart, readyEnd);
    // Floor: the slice really is the handler, so an empty read cannot pass.
    expect(readyHandler).toContain('isPostgresReady');

    for (const gone of ['kaanaBlocksReadiness', 'relay_unreachable', 'no_healthy_providers']) {
      expect(readyHandler, `/ready acts on ${gone}`).not.toContain(gone);
    }
  });

  it('leaves the liveness probe consulting nothing', () => {
    /**
     * `/health/live` is what the `oxy-alia` target group polls today, so a
     * dependency in it is a dependency that can get a task KILLED. The Kaana
     * signal has no business in a liveness answer, and this asserts the handler
     * body between `'/live'` and the next route is still the unconditional one.
     */
    const liveStart = source.indexOf("router.get('/live'");
    const readyStart = source.indexOf("router.get('/ready'");
    expect(liveStart).toBeGreaterThan(0);
    expect(readyStart).toBeGreaterThan(liveStart);
    const liveHandler = source.slice(liveStart, readyStart);
    expect(liveHandler).toContain("status: 'alive'");
    for (const forbidden of ['kaanaConnectivity', 'kaanaBlocksReadiness', 'summariseProviders', 'await']) {
      expect(liveHandler, `/live consults ${forbidden}`).not.toContain(forbidden);
    }
  });
});
