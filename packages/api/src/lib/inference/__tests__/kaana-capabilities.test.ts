import { modelCapabilitiesSchema, type ModelCapabilities, type RoutingTarget } from '@oxyhq/contracts';
import { describe, expect, it } from 'vitest';

import type { AliaInferenceContext } from '../product-seam.js';
import {
  createRelayInferenceClient,
  type RelayClientConfig,
  type RelayCompletion,
  type RelayServiceCredential,
  type RelayTransport,
  type RelayTransportRequest,
} from '../kaana-client.js';
import { assertAllowedRelayOrigin } from '../kaana-endpoint.js';
import { CAPABILITY_ENFORCEMENT, type RelayRequestPayload } from '../kaana-request.js';

/** An approved Relay origin, branded through the one function that produces one. */
const ENDPOINT = assertAllowedRelayOrigin('https://api.oxy.so', 'development');

/**
 * Epic #139 workstream 3 — *"Support tools, structured output, vision,
 * reasoning, prompt caching and modality capabilities."*
 *
 * ## Why every assertion here drives the CLIENT
 *
 * "The client supports vision" is a claim about what happens to a request that
 * contains an image and to the stream that comes back — not about what
 * `violatedCapability` returns for a capability object. A suite written against
 * the helper would be green with the helper wired to nothing, which is the
 * green-and-inert failure. So each capability is exercised twice through
 * `createRelayInferenceClient`: once where the target lacks it (refused, and
 * NOTHING sent — read at the transport, because "refused" and "sent and failed"
 * are indistinguishable from the caller) and once where the target has it (sent
 * verbatim, or carried back intact).
 *
 * ## Why the six named capabilities are eleven tests
 *
 * The contract's `modelCapabilitiesSchema` has eleven fields, and the checkbox
 * names six English words that do not map one-to-one onto them: "vision" is the
 * `image` input modality, "structured output" is two fields that the contract
 * deliberately separates (`structuredOutput` for a schema, `jsonMode` for
 * syntactic JSON), and "modality capabilities" is both modality lists plus
 * `maxOutputTokens`. Rather than assert the six words, this asserts the eleven
 * fields and states where each is answered — which is what
 * {@link CAPABILITY_ENFORCEMENT} exists to make impossible to leave incomplete.
 */

/* -------------------------------------------------------------------------- */
/*  Harness                                                                    */
/* -------------------------------------------------------------------------- */

class CapturingTransport implements RelayTransport {
  readonly sent: RelayTransportRequest[] = [];

  constructor(private readonly frames: readonly Record<string, unknown>[]) {}

  send(input: RelayTransportRequest): Promise<AsyncIterable<unknown>> {
    this.sent.push(input);
    const frames = this.frames;
    return Promise.resolve(
      (async function* () {
        for (const frame of frames) yield frame;
      })(),
    );
  }
}

const CREDENTIAL: RelayServiceCredential = {
  getServiceToken: () => Promise.resolve('oxy-service-token-synthetic'),
  invalidateServiceToken: () => undefined,
};

const DEFAULT_TARGET: RoutingTarget = { kind: 'model', modelReference: 'oxy/test-model' };

/** Everything on, so a test turns exactly one thing off. */
const EVERYTHING: ModelCapabilities = modelCapabilitiesSchema.parse({
  inputModalities: ['text', 'image', 'audio'],
  outputModalities: ['text', 'image', 'audio', 'embedding'],
  tools: true,
  parallelToolCalls: true,
  structuredOutput: true,
  jsonMode: true,
  reasoning: true,
  streaming: true,
  promptCaching: true,
  maxContextTokens: 200_000,
  maxOutputTokens: 8_192,
});

function without(over: Partial<ModelCapabilities>): ModelCapabilities {
  return modelCapabilitiesSchema.parse({ ...EVERYTHING, ...over });
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

function payload(over: Partial<RelayRequestPayload> = {}): RelayRequestPayload {
  return {
    modality: 'text',
    input: {
      format: 'messages',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what day is it' }] }],
    },
    sampling: {},
    tools: [],
    client: { apiFormat: 'chat_completions', endpoint: '/v1/chat/completions' },
    ...over,
  };
}

const START = {
  schemaVersion: 1,
  type: 'start',
  requestId: 'relay-req-1',
  sequence: 0,
  generationId: 'gen-1',
  resolvedModelReference: 'oxy/test-model',
  servingProvider: 'oxy',
  startedAt: '2026-08-17T00:00:00.000Z',
};

const DONE = {
  schemaVersion: 1,
  type: 'done',
  requestId: 'relay-req-1',
  sequence: 99,
  generationId: 'gen-1',
  finishReason: 'stop',
  receiptId: 'rcpt-1',
  completedAt: '2026-08-17T00:00:01.000Z',
};

interface Driven {
  readonly sent: RelayTransportRequest[];
  readonly events: { readonly type: string; readonly error?: { readonly code: string; readonly param?: string } }[];
}

/** Run one call and report both what went out and what came back. */
async function drive(
  capabilities: ModelCapabilities,
  request: RelayRequestPayload,
  frames: readonly Record<string, unknown>[] = [START, DONE],
  over: Partial<RelayClientConfig> = {},
): Promise<Driven> {
  const transport = new CapturingTransport(frames);
  const built = createRelayInferenceClient({
    enabled: true,
    transport,
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
    circuit: { failureThreshold: 5, cooldownMs: 1_000 },
    capabilitiesFor: () => capabilities,
    ...over,
  });

  const events: Driven['events'] = [];
  for await (const event of built.stream({ context: context(), payload: request }, new AbortController().signal)) {
    events.push(event.type === 'error' ? { type: 'error', error: event.error } : { type: event.type });
  }
  return { sent: transport.sent, events };
}

/** Fold a call to a completion, so the RESPONSE half can be asserted. */
async function complete(
  capabilities: ModelCapabilities,
  request: RelayRequestPayload,
  frames: readonly Record<string, unknown>[],
): Promise<RelayCompletion> {
  const built = createRelayInferenceClient({
    enabled: true,
    transport: new CapturingTransport(frames),
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
    circuit: { failureThreshold: 5, cooldownMs: 1_000 },
    capabilitiesFor: () => capabilities,
  });
  return built.generate({ context: context(), payload: request }, new AbortController().signal);
}

/** A refusal, asserted the way that distinguishes it from a failed request. */
function expectRefusal(driven: Driven, code: string, param: string): void {
  expect(driven.sent, 'a request went out for a capability the target lacks').toEqual([]);
  expect(driven.events).toHaveLength(1);
  expect(driven.events[0].type).toBe('error');
  expect(driven.events[0].error?.code).toBe(code);
  expect(driven.events[0].error?.param).toBe(param);
}

/* -------------------------------------------------------------------------- */
/*  The table is exhaustive over the contract                                  */
/* -------------------------------------------------------------------------- */

describe('every capability the contract defines has an answer (#139 ws3)', () => {
  it('covers exactly the fields of modelCapabilitiesSchema', () => {
    // The runtime half of the module's `satisfies Record<keyof ModelCapabilities, …>`:
    // `tsc` catches a capability ADDED upstream, and this catches one renamed or
    // removed there, which type-checks fine against a stale table.
    const fields = Object.keys(modelCapabilitiesSchema.shape).sort();
    expect(Object.keys(CAPABILITY_ENFORCEMENT).sort()).toEqual(fields);
    // The floor: an equality between two empty lists is not a check.
    expect(fields).toHaveLength(11);
  });

  it('partitions them into the three places they can be answered', () => {
    const by = (where: string): string[] =>
      Object.entries(CAPABILITY_ENFORCEMENT)
        .filter(([, enforcement]) => enforcement.where === where)
        .map(([name]) => name)
        .sort();

    expect(by('request')).toEqual([
      'inputModalities',
      'jsonMode',
      'maxOutputTokens',
      'outputModalities',
      'streaming',
      'structuredOutput',
      'tools',
    ]);
    // Not a request field in this contract, so refusing would invent a
    // restriction. Each is asserted below to survive the round trip instead.
    expect(by('response')).toEqual(['parallelToolCalls', 'promptCaching', 'reasoning']);
    // Needs a tokenizer for the resolved revision — provider knowledge this
    // client must not hold.
    expect(by('relay')).toEqual(['maxContextTokens']);
  });

  it('checks streaming first, because a non-streaming target can serve nothing', async () => {
    // Order is behaviour, not presentation: a target that cannot stream also
    // lacks tools here, and reporting the narrower violation would send a caller
    // to fix the wrong thing.
    const driven = await drive(
      without({ streaming: false, tools: false }),
      payload({ tools: [SEARCH_TOOL] }),
    );
    expectRefusal(driven, 'unsupported_modality', 'stream');
  });
});

/* -------------------------------------------------------------------------- */
/*  Tools                                                                      */
/* -------------------------------------------------------------------------- */

const SEARCH_TOOL = {
  type: 'function' as const,
  name: 'search',
  description: 'search the web',
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
};

describe('tools', () => {
  it('refuses a tool-carrying request against a target without tools', async () => {
    expectRefusal(await drive(without({ tools: false }), payload({ tools: [SEARCH_TOOL] })), 'invalid_request', 'tools');
  });

  it('sends the definitions verbatim when the target has tools', async () => {
    const driven = await drive(EVERYTHING, payload({ tools: [SEARCH_TOOL] }));
    expect(driven.sent).toHaveLength(1);
    expect(driven.sent[0].request.tools).toEqual([SEARCH_TOOL]);
  });

  it('does not refuse a toolless request against a target without tools', async () => {
    // The control that makes the refusal above about the tools rather than about
    // the capability object.
    const driven = await drive(without({ tools: false }), payload());
    expect(driven.sent).toHaveLength(1);
  });

  it('folds streamed tool calls back into the completion', async () => {
    const completion = await complete(EVERYTHING, payload({ tools: [SEARCH_TOOL] }), [
      START,
      { schemaVersion: 1, type: 'tool_call', requestId: 'relay-req-1', sequence: 1, toolCallId: 'call-1', name: 'search', argumentsDelta: '{"q":"', complete: false },
      { schemaVersion: 1, type: 'tool_call', requestId: 'relay-req-1', sequence: 2, toolCallId: 'call-1', argumentsDelta: 'weather"}', complete: true },
      DONE,
    ]);
    expect(completion.toolCalls).toEqual([{ id: 'call-1', name: 'search', arguments: '{"q":"weather"}' }]);
  });
});

describe('parallel tool calls', () => {
  it('keeps concurrent calls separate, keyed by toolCallId', async () => {
    // The observable form of `parallelToolCalls`: two calls interleaved inside
    // one generation. A client that folded by NAME or by arrival order would
    // merge them, and the product would execute one tool with the other's
    // arguments.
    const completion = await complete(EVERYTHING, payload({ tools: [SEARCH_TOOL] }), [
      START,
      { schemaVersion: 1, type: 'tool_call', requestId: 'relay-req-1', sequence: 1, toolCallId: 'call-a', name: 'search', argumentsDelta: '{"q":"a"}', complete: true },
      { schemaVersion: 1, type: 'tool_call', requestId: 'relay-req-1', sequence: 2, toolCallId: 'call-b', name: 'search', argumentsDelta: '{"q":"b"}', complete: true },
      DONE,
    ]);
    expect(completion.toolCalls).toEqual([
      { id: 'call-a', name: 'search', arguments: '{"q":"a"}' },
      { id: 'call-b', name: 'search', arguments: '{"q":"b"}' },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Structured output                                                          */
/* -------------------------------------------------------------------------- */

const JSON_SCHEMA_FORMAT = {
  type: 'json_schema' as const,
  name: 'answer',
  strict: true,
  schema: { type: 'object', properties: { a: { type: 'string' } } },
};

describe('structured output', () => {
  it('refuses a json_schema request against a target without structured output', async () => {
    expectRefusal(
      await drive(without({ structuredOutput: false }), payload({ responseFormat: JSON_SCHEMA_FORMAT })),
      'invalid_request',
      'responseFormat',
    );
  });

  it('refuses a json_object request against a target without json mode', async () => {
    // A separate field on purpose: a model can produce syntactically valid JSON
    // without honouring a schema, so collapsing the two would refuse requests
    // Relay serves.
    expectRefusal(
      await drive(without({ jsonMode: false }), payload({ responseFormat: { type: 'json_object' } })),
      'invalid_request',
      'responseFormat',
    );
  });

  it('does not confuse the two: json_object survives a schema-less target', async () => {
    const driven = await drive(without({ structuredOutput: false }), payload({ responseFormat: { type: 'json_object' } }));
    expect(driven.sent).toHaveLength(1);
    expect(driven.sent[0].request.responseFormat).toEqual({ type: 'json_object' });
  });

  it('sends the schema verbatim when the target supports it', async () => {
    const driven = await drive(EVERYTHING, payload({ responseFormat: JSON_SCHEMA_FORMAT }));
    expect(driven.sent[0]?.request.responseFormat).toEqual(JSON_SCHEMA_FORMAT);
  });
});

/* -------------------------------------------------------------------------- */
/*  Vision                                                                     */
/* -------------------------------------------------------------------------- */

const IMAGE_TURN: RelayRequestPayload['input'] = {
  format: 'messages',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this picture' },
        { type: 'image', source: { kind: 'url', url: 'https://cdn.alia.onl/uploads/1.png' } },
      ],
    },
  ],
};

describe('vision', () => {
  it('refuses an image turn against a target that takes no image input', async () => {
    // "Vision" is the `image` INPUT modality; the contract has no separate flag,
    // so this is where the checkbox's word lands.
    expectRefusal(
      await drive(without({ inputModalities: ['text'] }), payload({ input: IMAGE_TURN })),
      'unsupported_modality',
      'input',
    );
  });

  it('sends the image part verbatim to a target that takes images', async () => {
    const driven = await drive(EVERYTHING, payload({ input: IMAGE_TURN }));
    expect(driven.sent).toHaveLength(1);
    expect(driven.sent[0].request.input).toEqual(IMAGE_TURN);
  });

  it('does not refuse a text-only turn against a text-only target', async () => {
    const driven = await drive(without({ inputModalities: ['text'] }), payload());
    expect(driven.sent).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Modality                                                                   */
/* -------------------------------------------------------------------------- */

describe('modality capabilities', () => {
  it('refuses an output modality the target cannot produce', async () => {
    expectRefusal(
      await drive(without({ outputModalities: ['text'] }), payload({ modality: 'image' })),
      'unsupported_modality',
      'modality',
    );
  });

  it('allows a non-text output modality the target can produce', async () => {
    const driven = await drive(EVERYTHING, payload({ modality: 'image' }));
    expect(driven.sent[0]?.request.modality).toBe('image');
  });

  it('refuses an audio input turn against a target without audio input', async () => {
    const audioTurn: RelayRequestPayload['input'] = {
      format: 'messages',
      messages: [
        {
          role: 'user',
          content: [{ type: 'audio', source: { kind: 'url', url: 'https://cdn.alia.onl/uploads/1.webm' } }],
        },
      ],
    };
    expectRefusal(
      await drive(without({ inputModalities: ['text', 'image'] }), payload({ input: audioTurn })),
      'unsupported_modality',
      'input',
    );
  });

  it('refuses more output tokens than the target can emit', async () => {
    expectRefusal(
      await drive(EVERYTHING, payload({ maxOutputTokens: 8_193 })),
      'output_limit_exceeded',
      'maxOutputTokens',
    );
    // The boundary, so the comparison is `>` rather than `>=`.
    const driven = await drive(EVERYTHING, payload({ maxOutputTokens: 8_192 }));
    expect(driven.sent).toHaveLength(1);
  });

  it('leaves maxContextTokens to Relay', async () => {
    // A prompt far beyond a tiny context window is NOT refused here: counting it
    // needs a tokenizer for the resolved revision. `context_length_exceeded`
    // comes back from Relay, and a client that guessed would refuse requests
    // Relay would have served.
    const driven = await drive(without({ maxContextTokens: 8 }), payload());
    expect(driven.sent).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Reasoning and prompt caching                                               */
/* -------------------------------------------------------------------------- */

describe('reasoning', () => {
  it('does not refuse against a target that cannot reason, because nothing asks for it', async () => {
    // Stated rather than left as a silent gap: `inferenceRequestSchema` has no
    // reasoning field, so a refusal here would be a restriction Alia invented.
    const driven = await drive(without({ reasoning: false }), payload());
    expect(driven.sent).toHaveLength(1);
  });

  it('carries reasoning output back separately from the answer', async () => {
    const completion = await complete(EVERYTHING, payload(), [
      START,
      { schemaVersion: 1, type: 'delta', requestId: 'relay-req-1', sequence: 1, outputIndex: 0, channel: 'reasoning', text: 'let me think' },
      { schemaVersion: 1, type: 'delta', requestId: 'relay-req-1', sequence: 2, outputIndex: 0, channel: 'output_text', text: 'Tuesday' },
      DONE,
    ]);
    // Separately: a client that concatenated them would put chain-of-thought in
    // the user's answer.
    expect(completion.reasoningText).toBe('let me think');
    expect(completion.outputText).toBe('Tuesday');
  });

  it('carries the reasoning usage unit back untouched', async () => {
    const completion = await complete(EVERYTHING, payload(), [
      START,
      {
        schemaVersion: 1,
        type: 'usage',
        requestId: 'relay-req-1',
        sequence: 1,
        usageSource: 'provider_reported',
        units: [
          { unit: 'input_tokens', quantity: 100 },
          { unit: 'reasoning_tokens', quantity: 512 },
          { unit: 'output_tokens', quantity: 20 },
        ],
      },
      DONE,
    ]);
    expect(completion.usage).toContainEqual({ unit: 'reasoning_tokens', quantity: 512 });
    expect(completion.usageSource).toBe('provider_reported');
  });
});

describe('prompt caching', () => {
  it('does not refuse against a target without it, because nothing asks for it', async () => {
    const driven = await drive(without({ promptCaching: false }), payload());
    expect(driven.sent).toHaveLength(1);
  });

  it('carries cached_input_tokens back untouched, separate from uncached input', async () => {
    // The product prices a turn from these units. A client that summed them, or
    // dropped the cached one, would make cost attribution wrong with no error
    // anywhere — the quiet failure prompt caching is most likely to cause.
    const completion = await complete(EVERYTHING, payload(), [
      START,
      {
        schemaVersion: 1,
        type: 'usage',
        requestId: 'relay-req-1',
        sequence: 1,
        usageSource: 'provider_reported',
        units: [
          { unit: 'input_tokens', quantity: 40 },
          { unit: 'cached_input_tokens', quantity: 1_960 },
          { unit: 'output_tokens', quantity: 12 },
        ],
      },
      DONE,
    ]);
    expect(completion.usage).toEqual([
      { unit: 'input_tokens', quantity: 40 },
      { unit: 'cached_input_tokens', quantity: 1_960 },
      { unit: 'output_tokens', quantity: 12 },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*  No capability source, no check                                             */
/* -------------------------------------------------------------------------- */

describe('with no capability source the client refuses nothing', () => {
  it('sends a request the catalogue would have refused', async () => {
    // The state of the world until workstream 5 lands a catalogue, stated here
    // so it is a known property rather than a surprise: `capabilitiesFor` is
    // optional, and a client without one performs no capability check at all.
    const transport = new CapturingTransport([START, DONE]);
    const built = createRelayInferenceClient({
      enabled: true,
      transport,
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
      circuit: { failureThreshold: 5, cooldownMs: 1_000 },
    });

    for await (const _event of built.stream(
      { context: context(), payload: payload({ tools: [SEARCH_TOOL], modality: 'image' }) },
      new AbortController().signal,
    )) {
      // Drained.
    }
    expect(transport.sent).toHaveLength(1);
  });
});
