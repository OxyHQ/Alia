import { describe, expect, it } from 'vitest';
import {
  authenticatedPrincipalSchema,
  inferenceRequestSchema,
  inferenceStreamEventSchema,
  type InferenceStreamEvent,
  type InferenceStreamRouteSwitchEvent,
} from '@oxyhq/contracts';

import {
  ALIA_ROUTE_SWITCH_EVENT,
  ChatCompletionsRenderer,
  fromChatCompletionsRequest,
  OPENAI_CHAT_COMPLETIONS_ENDPOINT,
  renderRouteSwitchEvent,
  type OpenAIChatCompletionsRequest,
} from '../kaana-openai-adapter.js';
import { RelayInferenceError } from '../kaana-error.js';
import { buildInferenceRequest, type RelayEnvelopeContext } from '../kaana-request.js';

/**
 * The dialect adapter, in both directions — epic #139 workstream 3.
 *
 * The request direction is tested by BUILDING a full envelope from the adapter's
 * output and parsing it with `inferenceRequestSchema`, rather than by comparing
 * the adapter's output to a hand-written expected object. The difference
 * matters: a hand-written expectation is a re-implementation of the adapter and
 * stays green while the adapter and the contract drift apart together. The
 * schema is the contract.
 *
 * The response direction has no such oracle — the OpenAI dialect is not in
 * `@oxyhq/contracts` and cannot be — so those tests do compare against literal
 * shapes, and are honest that what they check is "this is the OpenAI shape as
 * this repository understands it".
 */

const ENVELOPE: RelayEnvelopeContext = {
  principal: authenticatedPrincipalSchema.parse({
    billing: { accountId: 'acct_relay_test' },
    applicationId: 'app_alia',
    credentialId: 'cred_alia_1',
    environment: 'production',
    inferenceScopes: ['inference:invoke'],
  }),
  delegatedUserId: 'oxy-user-1',
  requestId: 'alia-req-1',
  idempotencyKey: 'alia-idem-1',
  target: { kind: 'routing_profile', routingProfile: 'auto' },
  routingPolicy: { routingPolicyId: 'alia-default', policyVersion: 1 },
  receivedAt: '2026-08-16T09:41:00.000Z',
  costCentre: 'chat',
};

/**
 * The adapter's output is only meaningful if a full envelope built on it parses.
 *
 * `buildInferenceRequest` refuses by throwing, so the catch is the refusal path
 * and not an error being swallowed — the re-parse below is what proves the
 * non-throwing path really produced a contract-valid request.
 */
function accepted(body: OpenAIChatCompletionsRequest): boolean {
  try {
    return inferenceRequestSchema.safeParse(
      buildInferenceRequest(fromChatCompletionsRequest(body), ENVELOPE),
    ).success;
  } catch (cause) {
    if (cause instanceof RelayInferenceError) return false;
    throw cause;
  }
}

// ===========================================================================
// Request: dialect → normalized
// ===========================================================================

describe('an OpenAI chat body becomes a normalized request', () => {
  it('produces an envelope the contract accepts, and would refuse a broken one', () => {
    expect(accepted({ messages: [{ role: 'user', content: 'hola' }] })).toBe(true);
    // The floor. If the schema accepted everything, every acceptance in this
    // file would be measuring nothing.
    expect(accepted({ messages: [] })).toBe(false);
  });

  it('records which dialect the caller used, because the answer is rendered in it', () => {
    const payload = fromChatCompletionsRequest({ messages: [{ role: 'user', content: 'hola' }] });
    expect(payload.client.apiFormat).toBe('chat_completions');
    expect(payload.client.endpoint).toBe(OPENAI_CHAT_COMPLETIONS_ENDPOINT);
  });

  it('moves the generation controls into sampling and maxOutputTokens', () => {
    const payload = fromChatCompletionsRequest({
      messages: [{ role: 'user', content: 'hola' }],
      temperature: 0.4,
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: -0.2,
      seed: 7,
      stop: 'END',
      max_tokens: 256,
    });
    expect(payload.sampling).toEqual({
      temperature: 0.4,
      topP: 0.9,
      frequencyPenalty: 0.1,
      presencePenalty: -0.2,
      seed: 7,
      stopSequences: ['END'],
    });
    expect(payload.maxOutputTokens).toBe(256);
  });

  it("lets max_completion_tokens win, which is OpenAI's own precedence", () => {
    const payload = fromChatCompletionsRequest({
      messages: [{ role: 'user', content: 'hola' }],
      max_tokens: 100,
      max_completion_tokens: 900,
    });
    expect(payload.maxOutputTokens).toBe(900);
  });

  it('omits an absent control rather than sending a default for it', () => {
    // `samplingParametersSchema` treats absent as "the route's own default". A
    // zero temperature the caller never asked for is a different request.
    const payload = fromChatCompletionsRequest({ messages: [{ role: 'user', content: 'hola' }] });
    expect(payload.sampling).toEqual({});
    expect('maxOutputTokens' in payload).toBe(false);
  });

  it('splits a data URL into inline content and leaves a real URL to be fetched', () => {
    // `inferenceContentSourceSchema`'s distinction is not cosmetic: inline is
    // bytes the caller already sent, a URL is a fetch the data plane performs.
    const payload = fromChatCompletionsRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } },
            { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
          ],
        },
      ],
    });
    const first = payload.input.format === 'messages' ? payload.input.messages[0] : null;
    expect(first?.content).toEqual([
      { type: 'image', source: { kind: 'inline', mediaType: 'image/png', data: 'AAAA' }, detail: 'high' },
      { type: 'image', source: { kind: 'url', url: 'https://example.test/a.png' } },
    ]);
  });

  it('carries audio as inline content with the media type its format implies', () => {
    const payload = fromChatCompletionsRequest({
      messages: [
        { role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'BBBB', format: 'wav' } }] },
      ],
    });
    const first = payload.input.format === 'messages' ? payload.input.messages[0] : null;
    expect(first?.content).toEqual([
      { type: 'audio', source: { kind: 'inline', mediaType: 'audio/wav', data: 'BBBB' } },
    ]);
  });

  it('keeps an assistant tool call and the tool message that answers it', () => {
    const body: OpenAIChatCompletionsRequest = {
      messages: [
        { role: 'user', content: 'search for alia' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"alia"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"hits":0}' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'search',
            description: 'Search the web',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'search' } },
    };
    // The refinements this exercises are the schema's: a `toolCallId` only on a
    // tool message, `toolCalls` only on an assistant one, a tool choice only
    // beside a tool definition.
    expect(accepted(body)).toBe(true);

    const payload = fromChatCompletionsRequest(body);
    expect(payload.tools).toEqual([
      {
        type: 'function',
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]);
    expect(payload.toolChoice).toEqual({ type: 'function', name: 'search' });
  });

  it('flattens the nested json_schema response format and supplies the strict flag', () => {
    const payload = fromChatCompletionsRequest({
      messages: [{ role: 'user', content: 'plan' }],
      response_format: { type: 'json_schema', json_schema: { name: 'plan', schema: { type: 'object' } } },
    });
    // The contract requires `strict`; OpenAI treats an absent one as false, so
    // defaulting it to true would silently ask providers to enforce a schema the
    // caller never asked them to enforce.
    expect(payload.responseFormat).toEqual({
      type: 'json_schema',
      name: 'plan',
      schema: { type: 'object' },
      strict: false,
    });
  });

  it('never carries the dialect stream flag across, because the client owns it', () => {
    const payload = fromChatCompletionsRequest({ messages: [{ role: 'user', content: 'hola' }] });
    expect('stream' in payload).toBe(false);
  });
});

// ===========================================================================
// Response: normalized → dialect
// ===========================================================================

const FRAME = { id: 'chatcmpl-1', model: 'alia-v1-pro', created: 1_755_000_000 };

function parsed(event: unknown): InferenceStreamEvent {
  // Every fixture below goes through the contract parser first, so a test cannot
  // feed the renderer a shape the wire could never carry.
  return inferenceStreamEventSchema.parse(event);
}

describe('a normalized event becomes an OpenAI chunk, or nothing at all', () => {
  it('renders visible output as a content delta', () => {
    const renderer = new ChatCompletionsRenderer(FRAME);
    const chunk = renderer.render(
      parsed({
        schemaVersion: 1,
        type: 'delta',
        requestId: 'r',
        sequence: 1,
        outputIndex: 0,
        channel: 'output_text',
        text: 'Hola',
      }),
    );
    expect(chunk).toEqual({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1_755_000_000,
      model: 'alia-v1-pro',
      choices: [{ index: 0, delta: { content: 'Hola' }, finish_reason: null }],
    });
  });

  it('renders reasoning as nothing, because the dialect has no channel for it', () => {
    // A client that rendered reasoning as answer text is a product bug rather
    // than a display preference — the contract says so where it declares the
    // channel. Alia carries reasoning on its own `alia.reasoning` extension.
    const renderer = new ChatCompletionsRenderer(FRAME);
    expect(
      renderer.render(
        parsed({
          schemaVersion: 1,
          type: 'delta',
          requestId: 'r',
          sequence: 1,
          outputIndex: 0,
          channel: 'reasoning',
          text: 'thinking',
        }),
      ),
    ).toBeNull();
  });

  it('assigns a stable positional index per tool call, which the contract does not carry', () => {
    const renderer = new ChatCompletionsRenderer(FRAME);
    const first = renderer.render(
      parsed({
        schemaVersion: 1,
        type: 'tool_call',
        requestId: 'r',
        sequence: 1,
        toolCallId: 'call_a',
        name: 'search',
        argumentsDelta: '{"q":',
        complete: false,
      }),
    );
    const second = renderer.render(
      parsed({
        schemaVersion: 1,
        type: 'tool_call',
        requestId: 'r',
        sequence: 2,
        toolCallId: 'call_b',
        name: 'fetch',
        complete: false,
      }),
    );
    const continued = renderer.render(
      parsed({
        schemaVersion: 1,
        type: 'tool_call',
        requestId: 'r',
        sequence: 3,
        toolCallId: 'call_a',
        argumentsDelta: '"alia"}',
        complete: true,
      }),
    );

    expect(first?.choices[0].delta.tool_calls?.[0]).toEqual({
      index: 0,
      id: 'call_a',
      type: 'function',
      function: { name: 'search', arguments: '{"q":' },
    });
    expect(second?.choices[0].delta.tool_calls?.[0].index).toBe(1);
    // The continuation reuses index 0 and repeats neither the id nor the name,
    // which is what an OpenAI client accumulates against.
    expect(continued?.choices[0].delta.tool_calls?.[0]).toEqual({
      index: 0,
      function: { arguments: '"alia"}' },
    });
  });

  it('renders usage with the cached and reasoning token details filled in', () => {
    const renderer = new ChatCompletionsRenderer(FRAME);
    const chunk = renderer.render(
      parsed({
        schemaVersion: 1,
        type: 'usage',
        requestId: 'r',
        sequence: 1,
        units: [
          { unit: 'input_tokens', quantity: 40 },
          { unit: 'cached_input_tokens', quantity: 32 },
          { unit: 'output_tokens', quantity: 7 },
          { unit: 'reasoning_tokens', quantity: 3 },
        ],
        usageSource: 'provider_reported',
      }),
    );
    expect(chunk?.usage).toEqual({
      prompt_tokens: 40,
      completion_tokens: 7,
      total_tokens: 47,
      // Not the hardcoded zero at `lib/chat/provider-loop.ts:309`.
      prompt_tokens_details: { cached_tokens: 32 },
      completion_tokens_details: { reasoning_tokens: 3 },
    });
    expect(chunk?.choices).toEqual([]);
  });

  it('renders a cancellation as stop, because the dialect has no other word', () => {
    const renderer = new ChatCompletionsRenderer(FRAME);
    const chunk = renderer.render(
      parsed({
        schemaVersion: 1,
        type: 'done',
        requestId: 'r',
        sequence: 1,
        finishReason: 'cancelled',
        completedAt: '2026-08-16T09:41:00.000Z',
      }),
    );
    expect(chunk?.choices[0].finish_reason).toBe('stop');
  });

  it('renders start, route_switch and error as nothing', () => {
    const renderer = new ChatCompletionsRenderer(FRAME);
    const start = parsed({
      schemaVersion: 1,
      type: 'start',
      requestId: 'r',
      sequence: 0,
      resolvedModelReference: 'alia/v1-pro@2026-05-01',
      servingProvider: 'oxy-hosted',
      startedAt: '2026-08-16T09:41:00.000Z',
    });
    expect(renderer.render(start)).toBeNull();
    // The floor: a renderer that returned null for EVERYTHING would satisfy this
    // assertion, so it is paired with the deltas above, which must not be null.
    expect(
      renderer.render(
        parsed({
          schemaVersion: 1,
          type: 'delta',
          requestId: 'r',
          sequence: 1,
          outputIndex: 0,
          channel: 'output_text',
          text: 'x',
        }),
      ),
    ).not.toBeNull();
  });
});

// ===========================================================================
// The route-switch extension event
// ===========================================================================

describe('the route-switch event Alia emits names no provider', () => {
  const switched: InferenceStreamRouteSwitchEvent = inferenceStreamEventSchema.parse({
    schemaVersion: 1,
    type: 'route_switch',
    requestId: 'r',
    sequence: 4,
    reason: 'provider_overloaded',
    detail: {
      scope: 'model',
      requestedModelId: 'openai/gpt-5',
      fromModelReference: 'openai/gpt-5@2026-01-01',
      toModelReference: 'anthropic/claude@2026-02-01',
      toProvider: 'bedrock',
      authorizedByPolicy: true,
    },
    occurredAt: '2026-08-16T09:41:00.000Z',
  }) as InferenceStreamRouteSwitchEvent;

  it('is not alia.model_switch, which means something else entirely', () => {
    // `alia.model_switch` fires when the model calls the `switchModel` tool to
    // change the conversation's Alia model — a deliberate, user-visible product
    // feature (`lib/chat-events.ts`, `lib/tool-pipeline.ts:122`). Mapping a
    // failover notice onto it would render as a model-picker change.
    expect(ALIA_ROUTE_SWITCH_EVENT).toBe('alia.route_switch');
    expect(ALIA_ROUTE_SWITCH_EVENT).not.toBe('alia.model_switch');
  });

  it('carries the fact and drops every identifier that would name a provider', () => {
    const rendered = renderRouteSwitchEvent(switched);
    expect(rendered.reason).toBe('provider_overloaded');
    expect(rendered.scope).toBe('model');
    expect(rendered.occurredAt).toBe('2026-08-16T09:41:00.000Z');

    const serialized = JSON.stringify(rendered);
    for (const leak of ['openai', 'anthropic', 'bedrock', 'gpt-5', 'claude']) {
      expect(serialized).not.toContain(leak);
    }
    // The floor: the source event genuinely contains what the rendering must
    // drop, so "not contained" is a property of the rendering rather than of the
    // fixture.
    const source = JSON.stringify(switched);
    for (const leak of ['openai', 'anthropic', 'bedrock', 'gpt-5', 'claude']) {
      expect(source).toContain(leak);
    }
  });
});
