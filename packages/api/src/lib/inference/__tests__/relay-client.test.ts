import { describe, expect, it } from 'vitest';
import {
  INFERENCE_ERROR_CODES,
  inferenceStreamEventSchema,
  type InferenceErrorCode,
  type InferenceStreamEvent,
  type ModelCapabilities,
  type RoutingTarget,
} from '@oxyhq/contracts';
import type { OxyServices } from '@oxyhq/core';

import { sanitizeMessage } from '../../errors/sanitize.js';
import type { AliaInferenceCall, AliaInferenceContext } from '../product-seam.js';
import { INFERENCE_ERROR_POLICY, RelayInferenceError, RelayTransportRefusal } from '../relay-error.js';
import {
  createRelayInferenceClient,
  type RelayClientConfig,
  type RelayServiceCredential,
  type RelayTransport,
  type RelayTransportRequest,
} from '../relay-client.js';
import { isRelayClientEnabled, RELAY_CLIENT_ENABLED_ENV } from '../relay-cutover.js';
import type { RelayRequestPayload } from '../relay-request.js';
import { assertAllowedRelayOrigin } from '../relay-endpoint.js';

/**
 * An approved Relay origin, branded through the one function that can produce
 * one. Every fixture below shares it, so a test that cares about the endpoint
 * says so by overriding it rather than by being the only one that sets it.
 */
const ENDPOINT = assertAllowedRelayOrigin('https://api.oxy.so', 'development');

/**
 * The Relay client's behavioural suite — epic #139 workstream 3.
 *
 * ## What a fake transport does and does not prove
 *
 * There is no Relay to integration-test against — the Oxy inference edge is not
 * mounted (gap analysis §1) — so every test below drives a fake. That fake is
 * honest about two things and dishonest about a third:
 *
 *  - it CAN prove the client's own logic: which events reach a caller, when a
 *    budget expires, whether a retry happens, what the idempotency key is on
 *    each attempt, what the circuit does. Those are decisions this client makes
 *    and nothing else makes them.
 *  - it CAN prove protocol conformance in one direction, because the events it
 *    emits and the requests it receives are parsed by the contract's own live
 *    zod schemas rather than by a hand-written matcher.
 *  - it CANNOT prove that Relay emits what this suite feeds in. Nothing
 *    available today can. Every "the client handles X" below should be read as
 *    "the client handles X as the contract describes X", and the contract is the
 *    only authority any of it rests on.
 *
 * ## The vacuity question, asked of the retry rule in particular
 *
 * "Never retry in a way that can double-charge or duplicate a tool effect" is
 * the assertion most easily written so it cannot fail — a suite that only ever
 * fed non-retryable errors would pass against a client with no rule at all. So
 * the retry section asserts the POSITIVE case first (a retryable failure with
 * nothing yielded IS retried, transport called twice), and every refusal below
 * it differs from that case in exactly one respect.
 */

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

const WIRE_REQUEST_ID = 'relay-req-1';
const STARTED_AT = '2026-08-16T09:41:00.000Z';

function startEvent(sequence = 0, over: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    type: 'start',
    requestId: WIRE_REQUEST_ID,
    sequence,
    resolvedModelReference: 'alia/v1-pro@2026-05-01',
    servingProvider: 'oxy-hosted',
    startedAt: STARTED_AT,
    ...over,
  };
}

function deltaEvent(sequence: number, text: string, channel = 'output_text'): unknown {
  return {
    schemaVersion: 1,
    type: 'delta',
    requestId: WIRE_REQUEST_ID,
    sequence,
    outputIndex: 0,
    channel,
    text,
  };
}

function doneEvent(sequence: number, over: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    type: 'done',
    requestId: WIRE_REQUEST_ID,
    sequence,
    finishReason: 'stop',
    completedAt: STARTED_AT,
    ...over,
  };
}

function errorEvent(sequence: number, code: InferenceErrorCode, retryable: boolean): unknown {
  return {
    schemaVersion: 1,
    type: 'error',
    requestId: WIRE_REQUEST_ID,
    sequence,
    error: {
      schemaVersion: 1,
      code,
      message: 'upstream said no',
      retryable,
      requestId: WIRE_REQUEST_ID,
    },
  };
}

async function* iterate(frames: readonly unknown[]): AsyncGenerator<unknown> {
  for (const frame of frames) yield frame;
}

/** Yields its frames, then stalls forever. Used for the idle-stream budget. */
async function* stall(frames: readonly unknown[]): AsyncGenerator<unknown> {
  for (const frame of frames) yield frame;
  await new Promise<never>(() => undefined);
}

class FakeTransport implements RelayTransport {
  readonly calls: RelayTransportRequest[] = [];

  constructor(
    private readonly script: (attempt: number) => Promise<AsyncIterable<unknown>>,
  ) {}

  send(input: RelayTransportRequest): Promise<AsyncIterable<unknown>> {
    this.calls.push(input);
    return this.script(this.calls.length - 1);
  }
}

/** Serves a fixed frame list on every attempt. */
function serving(...frames: readonly unknown[]): FakeTransport {
  return new FakeTransport(() => Promise.resolve(iterate(frames)));
}

class FakeCredential implements RelayServiceCredential {
  minted = 0;
  invalidated = 0;
  fail = false;

  getServiceToken(): Promise<string> {
    if (this.fail) return Promise.reject(new Error('credential rejected'));
    this.minted += 1;
    return Promise.resolve(`oxy-service-token-${this.minted}`);
  }

  invalidateServiceToken(): void {
    this.invalidated += 1;
  }
}

const DEFAULT_TARGET: RoutingTarget = { kind: 'routing_profile', routingProfile: 'auto' };

function context(over: Partial<AliaInferenceContext> = {}): AliaInferenceContext {
  return {
    surface: 'chat',
    visibility: 'user_turn',
    caller: { oxyUserId: 'oxy-user-1', billing: 'user_credits', viaApiKey: false },
    model: { kind: 'product_default' },
    conversationId: null,
    fallbackPolicy: null,
    budget: { connectMs: 500, firstTokenMs: 500, idleStreamMs: 500, totalMs: 5_000 },
    onDisconnect: 'finish_and_notify',
    ...over,
  };
}

function payload(over: Partial<RelayRequestPayload> = {}): RelayRequestPayload {
  return {
    modality: 'text',
    input: {
      format: 'messages',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hola' }] }],
    },
    sampling: {},
    tools: [],
    client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions' },
    ...over,
  };
}

function call(over: Partial<AliaInferenceContext> = {}): AliaInferenceCall<RelayRequestPayload> {
  return { context: context(over), payload: payload() };
}

interface Harness {
  readonly client: ReturnType<typeof createRelayInferenceClient>;
  readonly transport: FakeTransport;
  readonly credential: FakeCredential;
  readonly clock: { value: number };
}

function harness(over: Partial<RelayClientConfig> = {}): Harness {
  const transport = over.transport instanceof FakeTransport ? over.transport : serving(startEvent(0), doneEvent(1));
  const credential = new FakeCredential();
  const clock = { value: 1_000_000 };
  let ids = 0;
  const client = createRelayInferenceClient({
    enabled: true,
    transport,
    credential,
    endpoint: ENDPOINT,
    principal: {
      billing: { accountId: 'acct_relay_test' },
      applicationId: 'app_alia',
      credentialId: 'cred_alia_1',
      environment: 'production',
      inferenceScopes: ['inference:invoke'],
    },
    defaultTarget: DEFAULT_TARGET,
    routingPolicies: { 'cross-model': { routingPolicyId: 'alia-cross', policyVersion: 3 } },
    defaultRoutingPolicy: { routingPolicyId: 'alia-default', policyVersion: 1 },
    maxAttempts: 3,
    circuit: { failureThreshold: 2, cooldownMs: 30_000 },
    now: () => clock.value,
    newId: () => {
      ids += 1;
      return `id-${ids}`;
    },
    ...over,
  });
  return { client, transport, credential, clock };
}

async function collect(stream: AsyncIterable<InferenceStreamEvent>): Promise<InferenceStreamEvent[]> {
  const out: InferenceStreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

function terminal(events: readonly InferenceStreamEvent[]): InferenceStreamEvent {
  const last = events[events.length - 1];
  if (last === undefined) throw new Error('the stream yielded nothing at all');
  return last;
}

function terminalCode(events: readonly InferenceStreamEvent[]): string {
  const last = terminal(events);
  return last.type === 'error' ? last.error.code : last.type;
}

/* -------------------------------------------------------------------------- */
/*  The flag                                                                  */
/* -------------------------------------------------------------------------- */

describe('the client is off by default (#139 ws3, invariant: not the live path)', () => {
  it('reads exactly the literal "true"', () => {
    expect(isRelayClientEnabled({})).toBe(false);
    expect(isRelayClientEnabled({ [RELAY_CLIENT_ENABLED_ENV]: '1' })).toBe(false);
    expect(isRelayClientEnabled({ [RELAY_CLIENT_ENABLED_ENV]: 'TRUE' })).toBe(false);
    expect(isRelayClientEnabled({ [RELAY_CLIENT_ENABLED_ENV]: 'true' })).toBe(true);
  });

  it('refuses without touching the transport when disabled', async () => {
    const { client, transport, credential } = harness({ enabled: false });
    const events = await collect(client.stream(call(), new AbortController().signal));
    expect(terminalCode(events)).toBe('service_unavailable');
    // The floor: a client that reached the transport and happened to fail would
    // look identical from the terminal code alone.
    expect(transport.calls).toHaveLength(0);
    expect(credential.minted).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Protocol conformance                                                      */
/* -------------------------------------------------------------------------- */

describe('every event the client yields is a contract event', () => {
  it('parses under the contract union, including the ones the client synthesizes', async () => {
    const { client } = harness({ transport: serving(startEvent(0), deltaEvent(1, 'hi'), doneEvent(2)) });
    const happy = await collect(client.stream(call(), new AbortController().signal));
    expect(happy).toHaveLength(3);

    const broken = harness({ transport: serving(startEvent(0)) });
    const truncated = await collect(broken.client.stream(call(), new AbortController().signal));
    expect(truncated).toHaveLength(2);

    for (const event of [...happy, ...truncated]) {
      expect(inferenceStreamEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it('sends an envelope whose attribution names the delegated user, not the payer', async () => {
    const { client, transport } = harness();
    await collect(client.stream(call(), new AbortController().signal));
    const sent = transport.calls[0].request;
    expect(sent.attribution.userId).toBe('oxy-user-1');
    expect(sent.attribution.principal.billing.accountId).toBe('acct_relay_test');
    expect(sent.client.apiFormat).toBe('chat_completions');
    expect(sent.stream).toBe(true);
  });

  it('bills the call to the surface the seam named, not to a default', async () => {
    const { client, transport } = harness();
    await collect(
      client.stream(
        { context: context({ surface: 'deep_research' }), payload: payload() },
        new AbortController().signal,
      ),
    );
    expect(transport.calls[0].request.client.labels).toEqual({ 'alia.surface': 'deep_research' });
  });
});

describe('the stream union is closed, so an unexpected frame ends the stream', () => {
  it('refuses an unknown event type instead of ignoring it', async () => {
    // The behaviour `lib/chat/stream-runner.ts:371-373` gets wrong today: it
    // logs 'Unhandled chunk type' and continues, which is the permissive default
    // the contract's discriminated union exists to prevent.
    const { client } = harness({
      transport: serving(startEvent(0), { schemaVersion: 1, type: 'telemetry', requestId: WIRE_REQUEST_ID, sequence: 1 }, doneEvent(2)),
    });
    const events = await collect(client.stream(call(), new AbortController().signal));
    expect(events.map((e) => e.type)).toEqual(['start', 'error']);
    expect(terminalCode(events)).toBe('internal_error');
  });

  it('refuses a stream that does not open with start', async () => {
    const { client } = harness({ transport: serving(deltaEvent(0, 'hi'), doneEvent(1)) });
    const events = await collect(client.stream(call(), new AbortController().signal));
    expect(events.map((e) => e.type)).toEqual(['error']);
  });

  it('refuses an event belonging to a different request', async () => {
    const { client } = harness({
      transport: serving(startEvent(0), deltaEvent(1, 'hi'), { ...(doneEvent(2) as object), requestId: 'someone-else' }),
    });
    const events = await collect(client.stream(call(), new AbortController().signal));
    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'error']);
    expect(terminalCode(events)).toBe('internal_error');
  });

  it('drops a redelivered event and keeps the next real one', async () => {
    // What `sequence` is for: a redelivery must be detectable as a duplicate
    // rather than appended as new output. Two identical deltas without this rule
    // would show the user "hi hi".
    const { client } = harness({
      transport: serving(startEvent(0), deltaEvent(1, 'hi'), deltaEvent(1, 'hi'), deltaEvent(2, ' there'), doneEvent(3)),
    });
    const events = await collect(client.stream(call(), new AbortController().signal));
    const text = events.filter((e) => e.type === 'delta').map((e) => e.text);
    expect(text).toEqual(['hi', ' there']);
  });

  it('honours an error that arrives before any start', async () => {
    // A request refused before generation began never had a `start` to send.
    // Demanding one would replace the real code with a protocol violation, and
    // the two differ in the one property that matters here: a violation is
    // reported as `internal_error`, which IS retryable, while the code it
    // replaced — `insufficient_balance` — is not. The permissive reading would
    // retry a request that can never succeed.
    const { client, transport } = harness({
      transport: serving(errorEvent(0, 'insufficient_balance', false)),
    });
    const events = await collect(client.stream(call(), new AbortController().signal));
    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(terminalCode(events)).toBe('insufficient_balance');
    expect(transport.calls).toHaveLength(1);
  });

  it('treats a truncated stream as a failure, never as a done', async () => {
    const { client } = harness({ transport: serving(startEvent(0), deltaEvent(1, 'partial')) });
    const events = await collect(client.stream(call(), new AbortController().signal));
    expect(terminal(events).type).toBe('error');
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Route switches                                                            */
/* -------------------------------------------------------------------------- */

function routeSwitch(sequence: number, detail: Record<string, unknown>): unknown {
  return {
    schemaVersion: 1,
    type: 'route_switch',
    requestId: WIRE_REQUEST_ID,
    sequence,
    reason: 'provider_overloaded',
    detail,
    occurredAt: STARTED_AT,
  };
}

describe('a route switch is surfaced, and only when this request authorized it', () => {
  it('passes a same-model deployment switch through', async () => {
    const { client } = harness({
      transport: serving(
        startEvent(0),
        routeSwitch(1, {
          scope: 'deployment',
          modelReference: 'alia/v1-pro@2026-05-01',
          toProvider: 'oxy-hosted-eu',
        }),
        doneEvent(2),
      ),
    });
    const events = await collect(client.stream(call(), new AbortController().signal));
    expect(events.map((e) => e.type)).toEqual(['start', 'route_switch', 'done']);
  });

  it('refuses a "deployment" switch that names a different model', async () => {
    // Same-model failover that changes the model is not same-model failover. The
    // schema cannot catch this: it does not know what `start` resolved.
    const { client } = harness({
      transport: serving(
        startEvent(0),
        routeSwitch(1, {
          scope: 'deployment',
          modelReference: 'other/model@1',
          toProvider: 'oxy-hosted',
        }),
        doneEvent(2),
      ),
    });
    const events = await collect(client.stream(call(), new AbortController().signal));
    expect(events.map((e) => e.type)).toEqual(['start', 'error']);
  });

  const crossModel = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    scope: 'model',
    requestedModelId: 'alia/v1-pro',
    fromModelReference: 'alia/v1-pro@2026-05-01',
    toModelReference: 'alia/v1@2026-05-01',
    toProvider: 'oxy-hosted',
    authorizedByPolicy: true,
    ...over,
  });

  it('passes a cross-model switch that echoes the unpinned model the caller asked for', async () => {
    const { client } = harness({
      transport: serving(startEvent(0), routeSwitch(1, crossModel()), doneEvent(2)),
    });
    const events = await collect(
      client.stream(
        { context: context({ model: { kind: 'user_selected', productModelId: 'alia/v1-pro' } }), payload: payload() },
        new AbortController().signal,
      ),
    );
    expect(events.map((e) => e.type)).toEqual(['start', 'route_switch', 'done']);
  });

  it('refuses a cross-model switch against a REVISION-PINNED request', async () => {
    // "A request that pinned a revision asked for exactly those weights and is
    // served or refused, never substituted." The contract says so in prose and
    // cannot enforce it, because the request is not in the event.
    const { client } = harness({
      transport: serving(startEvent(0), routeSwitch(1, crossModel()), doneEvent(2)),
    });
    const events = await collect(
      client.stream(
        {
          context: context({ model: { kind: 'user_selected', productModelId: 'alia/v1-pro@2026-05-01' } }),
          payload: payload(),
        },
        new AbortController().signal,
      ),
    );
    expect(events.map((e) => e.type)).toEqual(['start', 'error']);
  });

  it('refuses a cross-model switch that names a model the caller never asked for', async () => {
    const { client } = harness({
      transport: serving(startEvent(0), routeSwitch(1, crossModel({ requestedModelId: 'someone/else' })), doneEvent(2)),
    });
    const events = await collect(
      client.stream(
        { context: context({ model: { kind: 'user_selected', productModelId: 'alia/v1-pro' } }), payload: payload() },
        new AbortController().signal,
      ),
    );
    expect(events.map((e) => e.type)).toEqual(['start', 'error']);
  });

  it('leaves a routing-profile request alone, because choosing IS what a profile does', async () => {
    // Gap analysis §7 question 1: `requestedModelId` has no defined value for a
    // profile-targeted request. Refusing here would make profiles unusable the
    // moment Relay failed over.
    const { client } = harness({
      transport: serving(startEvent(0), routeSwitch(1, crossModel({ requestedModelId: 'anything/at-all' })), doneEvent(2)),
    });
    const events = await collect(client.stream(call(), new AbortController().signal));
    expect(events.map((e) => e.type)).toEqual(['start', 'route_switch', 'done']);
  });
});

/* -------------------------------------------------------------------------- */
/*  Budgets                                                                   */
/* -------------------------------------------------------------------------- */

describe('four independent budgets, one of which Alia does not have today', () => {
  const budget = {
    connectMs: 40,
    firstTokenMs: 40,
    idleStreamMs: 40,
    totalMs: 4_000,
  };

  it('gives up on a connect that never completes', async () => {
    const transport = new FakeTransport(() => new Promise<AsyncIterable<unknown>>(() => undefined));
    const { client } = harness({ transport });
    const started = Date.now();
    const events = await collect(client.stream(call({ budget }), new AbortController().signal));
    expect(terminalCode(events)).toBe('service_unavailable');
    expect(Date.now() - started).toBeLessThan(budget.totalMs);
  });

  it('gives up on a stream that never produces a first token', async () => {
    const transport = new FakeTransport(() => Promise.resolve(stall([])));
    const { client } = harness({ transport });
    const events = await collect(client.stream(call({ budget }), new AbortController().signal));
    expect(terminalCode(events)).toBe('provider_timeout');
  });

  it('gives up on a stream that stalls AFTER its first token', async () => {
    // The bug this budget fixes: `lib/chat/stream-runner.ts:146` clears the
    // first-byte timer on the first chunk and nothing re-arms it, so a stream
    // that delivers one token and stops runs to the 80-second global timeout
    // with the connection held open. `totalMs` here is 100x `idleStreamMs`, so
    // a client without the re-arm would take a hundred times as long.
    const transport = new FakeTransport(() => Promise.resolve(stall([startEvent(0), deltaEvent(1, 'hi')])));
    const { client } = harness({ transport });
    const started = Date.now();
    const events = await collect(client.stream(call({ budget }), new AbortController().signal));
    const elapsed = Date.now() - started;

    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'error']);
    expect(terminalCode(events)).toBe('provider_timeout');
    expect(elapsed).toBeLessThan(budget.totalMs / 4);
  });

  it('gives up on a stream that trickles forever inside its idle budget', async () => {
    async function* trickle(): AsyncGenerator<unknown> {
      yield startEvent(0);
      for (let sequence = 1; ; sequence += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield deltaEvent(sequence, '.');
      }
    }
    const transport = new FakeTransport(() => Promise.resolve(trickle()));
    const { client } = harness({ transport });
    const events = await collect(
      client.stream(call({ budget: { ...budget, totalMs: 120 } }), new AbortController().signal),
    );
    expect(terminalCode(events)).toBe('provider_timeout');
    expect(events.length).toBeGreaterThan(2);
  });
});

/* -------------------------------------------------------------------------- */
/*  Cancellation                                                              */
/* -------------------------------------------------------------------------- */

describe('cancellation is a reported state, not a dropped promise', () => {
  it('ends a live stream with the cancelled code', async () => {
    const transport = new FakeTransport(() => Promise.resolve(stall([startEvent(0), deltaEvent(1, 'hi')])));
    const { client } = harness({ transport });
    const controller = new AbortController();

    const events: InferenceStreamEvent[] = [];
    for await (const event of client.stream(call(), controller.signal)) {
      events.push(event);
      if (event.type === 'delta') controller.abort();
    }

    expect(terminalCode(events)).toBe('cancelled');
    // `cancelled` is on the contract's non-retryable list, so a cancelled call
    // cannot be retried into a second charge by any code path.
    const last = terminal(events);
    expect(last.type === 'error' ? last.error.retryable : true).toBe(false);
    expect(transport.calls).toHaveLength(1);
  });

  it('never reaches the transport when the caller cancelled first', async () => {
    const { client, transport } = harness();
    const controller = new AbortController();
    controller.abort();
    const events = await collect(client.stream(call(), controller.signal));
    expect(terminalCode(events)).toBe('cancelled');
    expect(transport.calls).toHaveLength(0);
  });

  it('leaves the disconnect decision to the caller, per the seam', async () => {
    // `onDisconnect` is a property of the CALL, and the client honours only the
    // signal it is handed: a chat turn whose client went away is
    // `finish_and_notify`, and finishing is what happens when nobody aborts.
    // Naming this here is what stops the cutover from "fixing" a shipped feature
    // (gap analysis §4.4) into an abort.
    const { client, transport } = harness();
    const events = await collect(
      client.stream(call({ onDisconnect: 'finish_and_notify' }), new AbortController().signal),
    );
    expect(terminal(events).type).toBe('done');
    expect(transport.calls).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Retries                                                                   */
/* -------------------------------------------------------------------------- */

describe('retry rules that cannot double-charge or duplicate a tool effect', () => {
  function toolCallEvent(sequence: number): unknown {
    return {
      schemaVersion: 1,
      type: 'tool_call',
      requestId: WIRE_REQUEST_ID,
      sequence,
      toolCallId: 'call_1',
      name: 'search',
      argumentsDelta: '{"q":"x"}',
      complete: true,
    };
  }

  it('DOES retry a retryable failure that produced nothing (the positive control)', async () => {
    // Without this, every refusal below would pass against a client that never
    // retries at all.
    const transport = new FakeTransport((attempt) =>
      Promise.resolve(
        iterate(attempt === 0 ? [errorEvent(0, 'provider_overloaded', true)] : [startEvent(0), doneEvent(1)]),
      ),
    );
    const { client } = harness({ transport });
    const events = await collect(client.stream(call(), new AbortController().signal));
    expect(transport.calls).toHaveLength(2);
    expect(terminal(events).type).toBe('done');
  });

  it('reuses ONE idempotency key across every attempt of one call', async () => {
    // The rule that makes a retry safe at all. A key minted per attempt would
    // satisfy every other conjunct and still charge twice, and nothing about the
    // event stream would look different.
    const transport = new FakeTransport((attempt) =>
      Promise.resolve(
        iterate(attempt === 0 ? [errorEvent(0, 'provider_overloaded', true)] : [startEvent(0), doneEvent(1)]),
      ),
    );
    const { client } = harness({ transport });
    await collect(client.stream(call(), new AbortController().signal));

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0].idempotencyKey).toBe(transport.calls[1].idempotencyKey);
    expect(transport.calls[0].idempotencyKey).not.toBe('');
    // The envelope's own key travels with it, so a transport that forwards the
    // request body rather than the header carries the same guarantee.
    expect(transport.calls[0].request.idempotencyKey).toBe(transport.calls[1].request.idempotencyKey);
    expect(transport.calls[0].request.attribution.requestId).toBe(
      transport.calls[1].request.attribution.requestId,
    );
  });

  it('does NOT retry once a tool call has reached the caller', async () => {
    // A `tool_call` event means the product may already have EXECUTED the tool.
    // Alia's current loop protects this structurally
    // (`lib/chat/provider-loop.ts:367` retries only when nothing streamed, and
    // `stream-runner.ts:187` marks streamed on the tool-call chunk); the rule is
    // restated here so the cutover cannot lose it.
    const transport = new FakeTransport((attempt) =>
      Promise.resolve(
        iterate(
          attempt === 0
            ? [startEvent(0), toolCallEvent(1), errorEvent(2, 'provider_overloaded', true)]
            : [startEvent(0), doneEvent(1)],
        ),
      ),
    );
    const { client } = harness({ transport });
    const events = await collect(client.stream(call(), new AbortController().signal));
    expect(transport.calls).toHaveLength(1);
    expect(terminalCode(events)).toBe('provider_overloaded');
  });

  it('does NOT retry once any output has reached the caller', async () => {
    const transport = new FakeTransport((attempt) =>
      Promise.resolve(
        iterate(
          attempt === 0
            ? [startEvent(0), deltaEvent(1, 'half an answer'), errorEvent(2, 'provider_overloaded', true)]
            : [startEvent(0), doneEvent(1)],
        ),
      ),
    );
    const { client } = harness({ transport });
    await collect(client.stream(call(), new AbortController().signal));
    expect(transport.calls).toHaveLength(1);
  });

  it('does NOT retry once the request has been metered', async () => {
    const usage = {
      schemaVersion: 1,
      type: 'usage',
      requestId: WIRE_REQUEST_ID,
      sequence: 1,
      units: [{ unit: 'input_tokens', quantity: 12 }],
      usageSource: 'provider_reported',
    };
    const transport = new FakeTransport((attempt) =>
      Promise.resolve(
        iterate(
          attempt === 0
            ? [startEvent(0), usage, errorEvent(2, 'provider_overloaded', true)]
            : [startEvent(0), doneEvent(1)],
        ),
      ),
    );
    const { client } = harness({ transport });
    await collect(client.stream(call(), new AbortController().signal));
    expect(transport.calls).toHaveLength(1);
  });

  it('does NOT retry once a generation has demonstrably started', async () => {
    // Deliberately stricter than "no output yet": a generation that began may
    // have been metered whether or not its output reached us, and the ledger
    // that would deduplicate a repeat (#972 workstream 7) does not exist yet.
    const transport = new FakeTransport((attempt) =>
      Promise.resolve(
        iterate(attempt === 0 ? [startEvent(0), errorEvent(1, 'provider_overloaded', true)] : [startEvent(0), doneEvent(1)]),
      ),
    );
    const { client } = harness({ transport });
    await collect(client.stream(call(), new AbortController().signal));
    expect(transport.calls).toHaveLength(1);
  });

  it('does NOT retry a code the contract says a retry cannot satisfy', async () => {
    const transport = new FakeTransport(() => Promise.resolve(iterate([errorEvent(0, 'insufficient_balance', false)])));
    const { client } = harness({ transport });
    const events = await collect(client.stream(call(), new AbortController().signal));
    expect(transport.calls).toHaveLength(1);
    expect(terminalCode(events)).toBe('insufficient_balance');
  });

  it('stops at maxAttempts rather than retrying forever', async () => {
    const transport = new FakeTransport(() => Promise.resolve(iterate([errorEvent(0, 'provider_overloaded', true)])));
    const { client } = harness({ transport, maxAttempts: 3 });
    await collect(client.stream(call(), new AbortController().signal));
    expect(transport.calls).toHaveLength(3);
  });

  it('performs exactly one attempt when retrying is configured off', async () => {
    const transport = new FakeTransport(() => Promise.resolve(iterate([errorEvent(0, 'provider_overloaded', true)])));
    const { client } = harness({ transport, maxAttempts: 1 });
    await collect(client.stream(call(), new AbortController().signal));
    expect(transport.calls).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Circuit                                                                   */
/* -------------------------------------------------------------------------- */

describe('the circuit breaks against Relay, and against nothing else', () => {
  it('opens after consecutive unavailability failures and then fails fast', async () => {
    const transport = new FakeTransport(() => Promise.resolve(iterate([errorEvent(0, 'service_unavailable', true)])));
    const { client } = harness({ transport, maxAttempts: 1, circuit: { failureThreshold: 2, cooldownMs: 30_000 } });

    await collect(client.stream(call(), new AbortController().signal));
    await collect(client.stream(call(), new AbortController().signal));
    expect(transport.calls).toHaveLength(2);

    const blocked = await collect(client.stream(call(), new AbortController().signal));
    expect(transport.calls).toHaveLength(2);
    expect(terminalCode(blocked)).toBe('service_unavailable');
    const last = terminal(blocked);
    expect(last.type === 'error' ? last.error.retryAfterMs : undefined).toBeGreaterThan(0);
  });

  it('does not open on a failure that is an answer about ONE request', async () => {
    // A `policy_violation` says the caller asked for something their policy
    // forbids. Counting it would let one misconfigured surface break inference
    // for every other one.
    const transport = new FakeTransport(() => Promise.resolve(iterate([errorEvent(0, 'policy_violation', false)])));
    const { client } = harness({ transport, maxAttempts: 1, circuit: { failureThreshold: 2, cooldownMs: 30_000 } });
    for (let i = 0; i < 5; i += 1) {
      await collect(client.stream(call(), new AbortController().signal));
    }
    expect(transport.calls).toHaveLength(5);
  });

  it('closes again once the cooldown has passed', async () => {
    const transport = new FakeTransport((attempt) =>
      Promise.resolve(iterate(attempt < 2 ? [errorEvent(0, 'service_unavailable', true)] : [startEvent(0), doneEvent(1)])),
    );
    const { client, clock } = harness({
      transport,
      maxAttempts: 1,
      circuit: { failureThreshold: 2, cooldownMs: 30_000 },
    });

    await collect(client.stream(call(), new AbortController().signal));
    await collect(client.stream(call(), new AbortController().signal));
    await collect(client.stream(call(), new AbortController().signal));
    expect(transport.calls).toHaveLength(2);

    clock.value += 30_001;
    const probe = await collect(client.stream(call(), new AbortController().signal));
    expect(transport.calls).toHaveLength(3);
    expect(terminal(probe).type).toBe('done');
  });

  it('a success resets the counter, so intermittent failures never accumulate', async () => {
    const transport = new FakeTransport((attempt) =>
      Promise.resolve(
        iterate(attempt % 2 === 0 ? [errorEvent(0, 'service_unavailable', true)] : [startEvent(0), doneEvent(1)]),
      ),
    );
    const { client } = harness({ transport, maxAttempts: 1, circuit: { failureThreshold: 2, cooldownMs: 30_000 } });
    for (let i = 0; i < 6; i += 1) {
      await collect(client.stream(call(), new AbortController().signal));
    }
    expect(transport.calls).toHaveLength(6);
  });
});

/* -------------------------------------------------------------------------- */
/*  Authentication                                                            */
/* -------------------------------------------------------------------------- */

describe('authentication is an Oxy service token, minted per attempt', () => {
  it('hands the transport a token it did not have to fetch itself', async () => {
    const { client, transport, credential } = harness();
    await collect(client.stream(call(), new AbortController().signal));
    expect(credential.minted).toBe(1);
    expect(transport.calls[0].authorization).toBe('oxy-service-token-1');
  });

  it('reports authentication_failed when the credential cannot be minted', async () => {
    const { client, credential, transport } = harness();
    credential.fail = true;
    const events = await collect(client.stream(call(), new AbortController().signal));
    expect(terminalCode(events)).toBe('authentication_failed');
    expect(transport.calls).toHaveLength(0);
  });

  it('invalidates the cached token when Relay rejects it, and does not retry', async () => {
    // A rotated credential is otherwise unrecoverable inside one process: the
    // cache keeps returning the still-unexpired token. Invalidating is what lets
    // the NEXT call succeed; retrying THIS one is forbidden, because the
    // contract lists `authentication_failed` as a code an identical retry can
    // never satisfy.
    const transport = new FakeTransport(() => Promise.resolve(iterate([errorEvent(0, 'authentication_failed', false)])));
    const { client, credential } = harness({ transport });
    await collect(client.stream(call(), new AbortController().signal));
    expect(credential.invalidated).toBe(1);
    expect(transport.calls).toHaveLength(1);
  });

  it('is structurally satisfied by the SDK client Alia already constructs', () => {
    // A positive control on the interface itself: `RelayServiceCredential` was
    // written against `@oxyhq/core`'s real surface, so if `getServiceToken` or
    // `invalidateServiceToken` were invented, this assignment fails to compile.
    // Type-only — nothing is constructed, so no network client exists at import.
    const satisfies = (credential: RelayServiceCredential): RelayServiceCredential => credential;
    const asCredential = (oxy: OxyServices): RelayServiceCredential => satisfies(oxy);
    expect(typeof asCredential).toBe('function');
  });
});

/* -------------------------------------------------------------------------- */
/*  Routing policy and capabilities                                           */
/* -------------------------------------------------------------------------- */

describe('the routing policy on a request is chosen explicitly', () => {
  it('records the default when the call names none', async () => {
    const { client, transport } = harness();
    await collect(client.stream(call(), new AbortController().signal));
    expect(transport.calls[0].request.routingPolicy).toEqual({
      routingPolicyId: 'alia-default',
      policyVersion: 1,
    });
  });

  it('records the named policy when the call names one', async () => {
    const { client, transport } = harness();
    await collect(client.stream(call({ fallbackPolicy: 'cross-model' }), new AbortController().signal));
    expect(transport.calls[0].request.routingPolicy).toEqual({
      routingPolicyId: 'alia-cross',
      policyVersion: 3,
    });
  });

  it('refuses an unknown policy name instead of quietly using the default', async () => {
    // Silently substituting a policy is silently substituting every decision the
    // policy makes, which is the failure #139's invariants exist to prevent.
    const { client, transport } = harness();
    const events = await collect(
      client.stream(call({ fallbackPolicy: 'no-such-policy' }), new AbortController().signal),
    );
    expect(terminalCode(events)).toBe('invalid_request');
    expect(transport.calls).toHaveLength(0);
  });
});

describe('capabilities are consulted when something knows them', () => {
  const capabilities: ModelCapabilities = {
    inputModalities: ['text'],
    outputModalities: ['text'],
    tools: false,
    parallelToolCalls: false,
    structuredOutput: false,
    jsonMode: false,
    reasoning: false,
    streaming: true,
    promptCaching: false,
    maxContextTokens: 8_000,
    maxOutputTokens: 1_000,
  };

  it('refuses before sending when the target cannot do what was asked', async () => {
    const { client, transport } = harness({ capabilitiesFor: () => capabilities });
    const withTools: AliaInferenceCall<RelayRequestPayload> = {
      context: context(),
      payload: payload({ tools: [{ type: 'function', name: 'search', parameters: {} }] }),
    };
    const events = await collect(client.stream(withTools, new AbortController().signal));
    expect(terminalCode(events)).toBe('invalid_request');
    expect(transport.calls).toHaveLength(0);
  });

  it('performs no check at all when nothing knows the capabilities', async () => {
    // The current state, stated rather than assumed: the catalogue is #139
    // workstream 5, and a hardcoded table here would be a second catalogue.
    const { client, transport } = harness();
    const withTools: AliaInferenceCall<RelayRequestPayload> = {
      context: context(),
      payload: payload({ tools: [{ type: 'function', name: 'search', parameters: {} }] }),
    };
    await collect(client.stream(withTools, new AbortController().signal));
    expect(transport.calls).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Transport refusals                                                        */
/* -------------------------------------------------------------------------- */

describe('a refusal Relay articulated beats the client guessing', () => {
  it('reads a typed error body off a rejected request', async () => {
    const body = {
      schemaVersion: 1,
      code: 'rate_limited',
      message: 'slow down',
      retryable: true,
      requestId: WIRE_REQUEST_ID,
      retryAfterMs: 0,
    };
    const transport = new FakeTransport(() => Promise.reject(new RelayTransportRefusal(body)));
    const { client } = harness({ transport, maxAttempts: 1 });
    const events = await collect(client.stream(call(), new AbortController().signal));
    expect(terminalCode(events)).toBe('rate_limited');
  });

  it('replaces a refusal whose text carries credential-shaped material', async () => {
    // `safeErrorTextSchema` refuses it, and the whole body is dropped rather
    // than partially trusted: the other fields came from the same place.
    const body = {
      schemaVersion: 1,
      code: 'provider_error',
      message: 'upstream rejected Authorization: Bearer sk-live-abcdefgh12345678',
      retryable: true,
      requestId: WIRE_REQUEST_ID,
    };
    const transport = new FakeTransport(() => Promise.reject(new RelayTransportRefusal(body)));
    const { client } = harness({ transport, maxAttempts: 1 });
    const events = await collect(client.stream(call(), new AbortController().signal));
    const last = terminal(events);
    expect(last.type).toBe('error');
    expect(terminalCode(events)).toBe('internal_error');
    expect(JSON.stringify(last)).not.toContain('sk-live');
  });

  it('reads an unreachable Relay as unavailability', async () => {
    const transport = new FakeTransport(() => Promise.reject(new Error('ECONNREFUSED')));
    const { client } = harness({ transport, maxAttempts: 1 });
    const events = await collect(client.stream(call(), new AbortController().signal));
    expect(terminalCode(events)).toBe('service_unavailable');
  });
});

/* -------------------------------------------------------------------------- */
/*  The fold                                                                  */
/* -------------------------------------------------------------------------- */

describe('generate folds the stream, because the contract publishes no completion', () => {
  it('accumulates every channel, the tool calls, the usage and the ids', async () => {
    const transport = serving(
      startEvent(0, { generationId: 'gen_1' }),
      deltaEvent(1, 'Hola'),
      deltaEvent(2, ' mundo'),
      deltaEvent(3, 'thinking', 'reasoning'),
      {
        schemaVersion: 1,
        type: 'tool_call',
        requestId: WIRE_REQUEST_ID,
        sequence: 4,
        toolCallId: 'call_1',
        name: 'search',
        argumentsDelta: '{"q":',
        complete: false,
      },
      {
        schemaVersion: 1,
        type: 'tool_call',
        requestId: WIRE_REQUEST_ID,
        sequence: 5,
        toolCallId: 'call_1',
        argumentsDelta: '"alia"}',
        complete: true,
      },
      {
        schemaVersion: 1,
        type: 'usage',
        requestId: WIRE_REQUEST_ID,
        sequence: 6,
        units: [
          { unit: 'input_tokens', quantity: 40 },
          { unit: 'cached_input_tokens', quantity: 32 },
          { unit: 'output_tokens', quantity: 7 },
        ],
        usageSource: 'provider_reported',
      },
      doneEvent(7, { generationId: 'gen_1', receiptId: 'rcpt_1', finishReason: 'tool_calls' }),
    );
    const { client } = harness({ transport });
    const completion = await client.generate(call(), new AbortController().signal);

    expect(completion.outputText).toBe('Hola mundo');
    expect(completion.reasoningText).toBe('thinking');
    expect(completion.toolCalls).toEqual([{ id: 'call_1', name: 'search', arguments: '{"q":"alia"}' }]);
    expect(completion.generationId).toBe('gen_1');
    expect(completion.receiptId).toBe('rcpt_1');
    expect(completion.finishReason).toBe('tool_calls');
    expect(completion.resolvedModelReference).toBe('alia/v1-pro@2026-05-01');
    expect(completion.usageSource).toBe('provider_reported');
    // Prompt caching has no representation in Alia today — the terminal chunk at
    // `lib/chat/provider-loop.ts:309` hardcodes `cached_tokens: 0`. It is a
    // metered unit under the contract, and the fold carries it.
    expect(completion.usage).toContainEqual({ unit: 'cached_input_tokens', quantity: 32 });
  });

  it('rejects with the contract error rather than returning a partial answer', async () => {
    const transport = serving(startEvent(0), deltaEvent(1, 'half'), errorEvent(2, 'provider_error', true));
    const { client } = harness({ transport, maxAttempts: 1 });
    await expect(client.generate(call(), new AbortController().signal)).rejects.toBeInstanceOf(
      RelayInferenceError,
    );
  });

  it('refuses a tool call the contract left nameless', async () => {
    const transport = serving(
      startEvent(0),
      {
        schemaVersion: 1,
        type: 'tool_call',
        requestId: WIRE_REQUEST_ID,
        sequence: 1,
        toolCallId: 'call_1',
        argumentsDelta: '{}',
        complete: true,
      },
      doneEvent(2),
    );
    const { client } = harness({ transport });
    await expect(client.generate(call(), new AbortController().signal)).rejects.toBeInstanceOf(
      RelayInferenceError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  Degradation                                                               */
/* -------------------------------------------------------------------------- */

describe('degradation is a decision about the surface, not about the error', () => {
  const { client } = harness();
  const errorFor = (code: InferenceErrorCode): RelayInferenceError =>
    new RelayInferenceError({
      schemaVersion: 1,
      code,
      message: 'internal detail nobody should read',
      retryable: false,
      requestId: 'r',
    });

  it('drops every failure silently on a surface nobody is watching', () => {
    for (const code of INFERENCE_ERROR_CODES) {
      expect(client.degrade(context({ visibility: 'background' }), errorFor(code)).kind).toBe('silent');
      expect(client.degrade(context({ visibility: 'derived' }), errorFor(code)).kind).toBe('silent');
    }
    // The floor: an empty code list would pass the loop above trivially.
    expect(INFERENCE_ERROR_CODES.length).toBe(26);
  });

  it('answers every code on a waiting surface, and answers it the same way twice', () => {
    let surfaced = 0;
    let synthetic = 0;
    for (const code of INFERENCE_ERROR_CODES) {
      const degradation = client.degrade(context(), errorFor(code));
      if (code === 'cancelled') {
        expect(degradation.kind).toBe('silent');
        continue;
      }
      const policy = INFERENCE_ERROR_POLICY[code];
      if (policy.httpStatus === null) {
        expect(degradation).toEqual({ kind: 'synthetic_reply', userMessage: policy.userMessage });
        synthetic += 1;
      } else {
        expect(degradation).toEqual({
          kind: 'surface_error',
          userMessage: policy.userMessage,
          httpStatus: policy.httpStatus,
        });
        surfaced += 1;
      }
    }
    // Both branches were exercised; a policy table that had collapsed to one
    // kind would still satisfy every individual assertion above.
    expect(surfaced).toBeGreaterThan(0);
    expect(synthetic).toBeGreaterThan(0);
  });

  it('never renders the producer text, whatever the producer wrote', () => {
    const leaky = new RelayInferenceError({
      schemaVersion: 1,
      code: 'provider_error',
      message: 'the upstream model gpt-5 refused',
      retryable: true,
      requestId: 'r',
    });
    const degradation = client.degrade(context(), leaky);
    const rendered = degradation.kind === 'silent' ? '' : degradation.userMessage;
    expect(rendered).not.toContain('gpt-5');
  });

  it('names no provider in any sentence a user can see', () => {
    // The oracle is Alia's own redaction list: `sanitizeMessage` rewrites every
    // registered provider name, so a message it leaves BYTE-IDENTICAL contains
    // none. Used here as a check, never on a wire object — running it on a
    // contract error would corrupt `providerError.provider`, which the contract
    // requires to be a real slug (gap analysis §3.8, trap 1).
    let checked = 0;
    for (const code of INFERENCE_ERROR_CODES) {
      const message = INFERENCE_ERROR_POLICY[code].userMessage;
      expect(sanitizeMessage(message)).toBe(message);
      checked += 1;
    }
    expect(checked).toBe(26);
    // The oracle's own positive control: it must be capable of rewriting
    // something, or "unchanged" means the sanitiser is inert rather than the
    // messages being clean.
    expect(sanitizeMessage('served by openai')).not.toBe('served by openai');
  });
});

