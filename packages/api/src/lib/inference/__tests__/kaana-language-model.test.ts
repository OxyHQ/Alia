import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requests: [] as Array<Record<string, unknown>>,
  options: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  streamFailure: null as Error | null,
}));

vi.mock('../oxy-inference.js', () => ({
  getOxyInferenceClient: () => ({
    respond: async (request: Record<string, unknown>, options: Record<string, unknown>) => {
      mocks.requests.push(request);
      mocks.options.push(options);
      return {
        requestId: 'req-1',
        model: 'openai/gpt-5-mini@2026-08-18',
        servingProvider: 'operator-that-must-not-leak',
        output: [{ role: 'assistant', content: [{ type: 'text', text: 'hola' }] }],
        finishReason: 'stop',
        usage: [
          { unit: 'input_tokens', quantity: 2 },
          { unit: 'output_tokens', quantity: 1 },
        ],
      };
    },
    stream: (request: Record<string, unknown>, options: Record<string, unknown>) => {
      mocks.requests.push(request);
      mocks.options.push(options);
      return (async function* () {
        for (const event of mocks.events) yield event;
        if (mocks.streamFailure !== null) throw mocks.streamFailure;
      })();
    },
  }),
}));

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  kaanaLanguageModel,
  PAST_TOOL_IMAGE_NOTE,
  TOOL_IMAGE_FOLLOWS_NOTE,
} from '../kaana-language-model.js';
import { OxyInferenceError } from '@oxy.so/core/inference';
import { toAliaError } from '../../errors/failover-error.js';

const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hola' }] }];

async function drain(stream: ReadableStream<unknown>): Promise<Array<Record<string, unknown>>> {
  const parts: Array<Record<string, unknown>> = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value as Record<string, unknown>);
  }
}

describe('Kaana AI SDK adapter through Oxy', () => {
  beforeEach(() => {
    mocks.requests.length = 0;
    mocks.options.length = 0;
    mocks.events.length = 0;
    mocks.streamFailure = null;
  });

  it('does not accept a request id from an arbitrary thrown object', async () => {
    const failure = Object.assign(new Error('fixture failure'), {
      requestId: 'untrusted-id',
    });
    mocks.streamFailure = failure;
    const onInferenceRequest = vi.fn();
    const model = kaanaLanguageModel({
      target: { kind: 'routingProfile', routingProfile: 'auto' },
      modelId: 'auto',
      surface: 'chat',
      onInferenceRequest,
    });
    const parts = await drain((await model.doStream({ prompt } as never)).stream);
    expect(parts.find((part) => part.type === 'error')?.error).toBe(failure);
    expect(onInferenceRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['rate_limited', true, 1250, 'RATE_LIMITED', 2],
    ['provider_billing_refused', false, undefined, 'PROVIDER_UNAVAILABLE', undefined],
    ['provider_credential_invalid', false, undefined, 'PROVIDER_UNAVAILABLE', undefined],
    ['no_route_available', false, undefined, 'PROVIDER_UNAVAILABLE', undefined],
    ['provider_timeout', true, undefined, 'TIMEOUT', undefined],
    ['quota_exceeded', false, undefined, 'QUOTA_EXCEEDED', undefined],
  ] as const)(
    'preserves %s through the stream and product classification',
    async (code, retryable, retryAfterMs, productCode, retryAfter) => {
      mocks.events.push({
        type: 'error',
        requestId: 'req-failed',
        error: {
          code,
          message: 'Upstream refused the request.',
          retryable,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      });
      const model = kaanaLanguageModel({
        target: { kind: 'model', model: 'acme/chat-1' },
        modelId: 'acme/chat-1',
        surface: 'chat',
      });
      const { stream } = await model.doStream({ prompt } as never);
      const parts = await drain(stream);
      const failure = parts.find((part) => part.type === 'error')?.error;
      expect(failure).toBeInstanceOf(OxyInferenceError);
      expect(failure).toMatchObject({ code, retryable, requestId: 'req-failed' });
      const productError = toAliaError(failure);
      expect(productError).toMatchObject({ code: productCode, retryable });
      expect(productError.retryAfter).toBe(retryAfter);
      expect(productError.httpStatus).toBeGreaterThanOrEqual(400);
      expect(productError.userMessage).not.toContain('Upstream');
      expect(parts.filter((part) => part.type === 'error')).toHaveLength(1);
      expect(parts.at(-1)).toMatchObject({
        type: 'finish',
        finishReason: { unified: 'error', raw: code },
      });
    },
  );

  it('sends a document to a model as the contract file part, and sends an image rather than dropping it', async () => {
    const model = kaanaLanguageModel({
      target: { kind: 'model', model: 'acme/reader-1' },
      modelId: 'acme/reader-1',
      surface: 'chat',
    });
    const result = await model.doGenerate({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Summarise it' },
            {
              type: 'file',
              data: new Uint8Array([37, 80, 68, 70]),
              mediaType: 'application/pdf',
              filename: 'lease.pdf',
            },
            { type: 'file', data: new Uint8Array([1]), mediaType: 'image/png' },
          ],
        },
      ],
    } as never);

    expect((mocks.requests[0].input as Array<{ content: unknown }>)[0].content).toEqual([
      { type: 'text', text: 'Summarise it' },
      {
        type: 'file',
        source: { kind: 'inline', mediaType: 'application/pdf', data: 'JVBERg==' },
        filename: 'lease.pdf',
      },
      { type: 'image', source: { kind: 'inline', mediaType: 'image/png', data: 'AQ==' } },
    ]);
    expect(result.warnings).toHaveLength(0);
  });

  it('sends the exact catalogue model and delegated user to Oxy', async () => {
    const model = kaanaLanguageModel({
      target: { kind: 'model', model: 'acme/chat-1' },
      modelId: 'acme/chat-1',
      surface: 'chat',
      oxyUserId: 'user-id',
    });
    const result = await model.doGenerate({ prompt, maxOutputTokens: 128 } as never);

    expect(mocks.requests[0]).toMatchObject({
      model: 'acme/chat-1',
      maxOutputTokens: 128,
      labels: { 'alia.surface': 'chat' },
    });
    expect(mocks.requests[0]).not.toHaveProperty('routingProfileId');
    expect(mocks.requests[0]).not.toHaveProperty('routingProfile');
    // No effort asked for: the model's own default, and nothing on the wire.
    expect(mocks.requests[0]).not.toHaveProperty('reasoning');
    expect(mocks.options[0]).toMatchObject({ delegatedUserId: 'user-id' });
    expect(result.content).toEqual([{ type: 'text', text: 'hola' }]);
  });

  it('leaves room for reasoning when the caller sets no output ceiling', async () => {
    const model = kaanaLanguageModel({
      target: { kind: 'routingProfile', routingProfile: 'auto' },
      modelId: 'auto',
      surface: 'chat',
    });
    await model.doGenerate({ prompt } as never);

    // 4096 was spent on reasoning before a tool-using turn wrote its answer.
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBeGreaterThan(4096);
    expect(mocks.requests[0]).toMatchObject({ maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS });
  });

  it('sends a power level as routingProfile, never as a model, and reports the model Oxy chose', async () => {
    const model = kaanaLanguageModel({
      target: { kind: 'routingProfile', routingProfile: 'high' },
      modelId: 'high',
      surface: 'chat',
    });
    const result = await model.doGenerate({ prompt } as never);

    expect(mocks.requests[0]).toMatchObject({ routingProfile: 'high' });
    expect(mocks.requests[0]).not.toHaveProperty('model');
    expect(mocks.requests[0]).not.toHaveProperty('routingProfileId');
    // The level sets its own effort at Oxy; Alia adds none.
    expect(mocks.requests[0]).not.toHaveProperty('reasoning');
    expect(result.providerMetadata).toEqual({
      kaana: { resolvedModelReference: 'openai/gpt-5-mini@2026-08-18' },
    });
  });

  it('forwards a reasoning effort as reasoning.effort on both methods', async () => {
    const model = kaanaLanguageModel({
      target: { kind: 'model', model: 'acme/thinker-1' },
      modelId: 'acme/thinker-1',
      surface: 'chat',
      reasoningEffort: 'high',
    });
    mocks.events.push({ type: 'done', finishReason: 'stop' });
    await model.doGenerate({ prompt } as never);
    await drain((await model.doStream({ prompt } as never)).stream);

    expect(mocks.requests).toHaveLength(2);
    for (const request of mocks.requests) {
      expect(request).toMatchObject({ model: 'acme/thinker-1', reasoning: { effort: 'high' } });
    }
  });

  it('sends a pinned canonical model without guessing from its spelling', async () => {
    const model = kaanaLanguageModel({
      target: { kind: 'model', model: 'openai/gpt-5-mini' },
      modelId: 'openai/gpt-5-mini',
      surface: 'authoring',
    });
    await model.doGenerate({ prompt } as never);

    expect(mocks.requests[0]).toMatchObject({ model: 'openai/gpt-5-mini' });
    expect(mocks.requests[0]).not.toHaveProperty('routingProfile');
  });

  it('sends a distinct Idempotency-Key on every respond and stream call', async () => {
    /**
     * The Oxy edge refuses a key already bound to a reservation with
     * `idempotency_conflict`, so the key must be unique per ATTEMPT: two steps
     * of one tool loop, or a stream after a respond, must never share one.
     * Both methods are driven, twice each, and every key is asserted distinct
     * and UUID-shaped — a fixed string per model instance would pass a
     * presence check and refuse every second request in production.
     */
    const model = kaanaLanguageModel({
      target: { kind: 'model', model: 'acme/chat-1' },
      modelId: 'acme/chat-1',
      surface: 'chat',
      oxyUserId: 'user-id',
    });
    mocks.events.push({ type: 'done', finishReason: 'stop' });

    await model.doGenerate({ prompt } as never);
    await model.doGenerate({ prompt } as never);
    await drain((await model.doStream({ prompt } as never)).stream);
    await drain((await model.doStream({ prompt } as never)).stream);

    const keys = mocks.options.map((o) => o.idempotencyKey);
    expect(keys).toHaveLength(4);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const key of keys) expect(key, String(key)).toMatch(uuid);
    expect(new Set(keys).size).toBe(4);
    // The key rides beside the other per-call options rather than replacing them.
    expect(mocks.options[0]).toMatchObject({ delegatedUserId: 'user-id' });
    expect(mocks.options[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('carries the resolved model reference out of a completed response, and nothing about the operator', async () => {
    /**
     * #139 L290/L703: the revision Kaana served reaches the usage record. It is
     * carried under the adapter's own `providerMetadata` namespace rather than
     * only as `response.modelId`, because the AI SDK fills a missing
     * `response.modelId` with the REQUESTED id and a reader could not tell the
     * two apart. `servingProvider` is on the same wire and must go nowhere.
     */
    const model = kaanaLanguageModel({
      target: { kind: 'model', model: 'acme/chat-1' },
      modelId: 'acme/chat-1',
      surface: 'chat',
    });
    const result = await model.doGenerate({ prompt } as never);

    expect(result.providerMetadata).toEqual({
      kaana: { resolvedModelReference: 'openai/gpt-5-mini@2026-08-18' },
    });
    expect(result.response?.modelId).toBe('openai/gpt-5-mini@2026-08-18');
    expect(JSON.stringify(result)).not.toContain('operator-that-must-not-leak');
  });

  it('reads the resolved model reference from the stream start event', async () => {
    mocks.events.push(
      {
        type: 'start',
        requestId: 'req-2',
        resolvedModelReference: 'anthropic/claude-sonnet-4@2026-08-18',
        servingProvider: 'operator-that-must-not-leak',
        startedAt: '2026-09-10T00:00:00.000Z',
      },
      { type: 'delta', channel: 'output_text', text: 'ho' },
      { type: 'done', finishReason: 'stop' },
    );
    const model = kaanaLanguageModel({
      target: { kind: 'model', model: 'acme/chat-1' },
      modelId: 'acme/chat-1',
      surface: 'chat',
    });
    const parts = await drain((await model.doStream({ prompt } as never)).stream);

    const metadata = parts.find((part) => part.type === 'response-metadata');
    expect(metadata).toMatchObject({
      id: 'req-2',
      modelId: 'anthropic/claude-sonnet-4@2026-08-18',
    });
    const finish = parts.at(-1);
    expect(finish?.type).toBe('finish');
    expect(finish?.providerMetadata).toEqual({
      kaana: { resolvedModelReference: 'anthropic/claude-sonnet-4@2026-08-18' },
    });
    expect(JSON.stringify(parts)).not.toContain('operator-that-must-not-leak');
  });

  it('carries no resolved model reference when the stream never started', async () => {
    // The discriminator: a stream with no `start` must not invent one from the
    // requested id. `finish` then has NO providerMetadata key at all.
    mocks.events.push({ type: 'done', finishReason: 'stop' });
    const model = kaanaLanguageModel({
      target: { kind: 'model', model: 'acme/chat-1' },
      modelId: 'acme/chat-1',
      surface: 'chat',
    });
    const parts = await drain((await model.doStream({ prompt } as never)).stream);
    expect(parts.some((part) => part.type === 'response-metadata')).toBe(false);
    expect(parts.at(-1)).not.toHaveProperty('providerMetadata');
  });

  it('streams through the SDK and keeps usage and finish semantics', async () => {
    mocks.events.push(
      { type: 'delta', channel: 'output_text', text: 'ho' },
      { type: 'usage', units: [{ unit: 'output_tokens', quantity: 1 }] },
      { type: 'done', finishReason: 'stop' },
    );
    const model = kaanaLanguageModel({
      target: { kind: 'model', model: 'acme/chat-1' },
      modelId: 'acme/chat-1',
      surface: 'chat',
    });
    const parts = await drain((await model.doStream({ prompt } as never)).stream);

    expect(parts.map((part) => part.type)).toEqual([
      'stream-start',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
    expect((parts.at(-1)?.usage as { outputTokens: { total: number } }).outputTokens.total).toBe(1);
  });

  it('never emits a tool call from a stream that errored part-way', async () => {
    // Arguments cut off by a failure are not something the model decided to
    // call: running the tool would act on a turn that already failed.
    mocks.events.push(
      { type: 'tool_call', toolCallId: 'call-1', name: 'webSearch', argumentsDelta: '{"q":"al' },
      { type: 'error', error: { code: 'upstream_error', message: 'cut', retryable: true } },
    );
    const model = kaanaLanguageModel({
      target: { kind: 'model', model: 'acme/chat-1' },
      modelId: 'acme/chat-1',
      surface: 'chat',
    });
    const parts = await drain((await model.doStream({ prompt } as never)).stream);

    expect(parts.some((part) => part.type === 'tool-call')).toBe(false);
    expect(parts.some((part) => part.type === 'error')).toBe(true);
    // The input block is still closed: a start with no end is a hang.
    expect(parts.filter((part) => part.type === 'tool-input-end')).toHaveLength(1);
    expect((parts.at(-1)?.finishReason as { unified: string }).unified).toBe('error');
  });

  it('control: a call cut off by a clean `done` is still emitted for the SDK to reject', async () => {
    mocks.events.push(
      { type: 'tool_call', toolCallId: 'call-1', name: 'webSearch', argumentsDelta: '{"q":"al' },
      { type: 'done', finishReason: 'length' },
    );
    const model = kaanaLanguageModel({
      target: { kind: 'model', model: 'acme/chat-1' },
      modelId: 'acme/chat-1',
      surface: 'chat',
    });
    const parts = await drain((await model.doStream({ prompt } as never)).stream);

    expect(parts.filter((part) => part.type === 'tool-call')).toHaveLength(1);
  });
});

describe('canonical disjoint token accounting', () => {
  it.each([
    { input: 0, cached: 3000, output: 0, reasoning: 60 },
    { input: 20, cached: 3000, output: 5, reasoning: 60 },
  ])(
    'includes cache and reasoning exactly once in streamed AI SDK totals: %j',
    async (quantities) => {
      mocks.events.length = 0;
      mocks.streamFailure = null;
      mocks.events.push(
        {
          type: 'usage',
          units: [
            { unit: 'input_tokens', quantity: quantities.input },
            { unit: 'cached_input_tokens', quantity: quantities.cached },
            { unit: 'output_tokens', quantity: quantities.output },
            { unit: 'reasoning_tokens', quantity: quantities.reasoning },
          ],
        },
        { type: 'done', requestId: 'req-accounting', finishReason: 'stop' },
      );
      const model = kaanaLanguageModel({
        target: { kind: 'model', model: 'acme/chat-1' },
        modelId: 'acme/chat-1',
        surface: 'chat',
      });
      const parts = await drain((await model.doStream({ prompt } as never)).stream);
      expect(parts.at(-1)?.usage).toEqual({
        inputTokens: {
          total: quantities.input + quantities.cached,
          noCache: quantities.input,
          cacheRead: quantities.cached,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: quantities.output + quantities.reasoning,
          text: quantities.output,
          reasoning: quantities.reasoning,
        },
      });
    },
  );
});

describe('images a tool returned', () => {
  beforeEach(() => {
    mocks.requests.length = 0;
    mocks.events.length = 0;
    mocks.streamFailure = null;
  });

  const call = (id: string) => ({
    role: 'assistant' as const,
    content: [{ type: 'tool-call' as const, toolCallId: id, toolName: 'shot', input: {} }],
  });
  const shot = (id: string, data: string) => ({
    role: 'tool' as const,
    content: [
      {
        type: 'tool-result' as const,
        toolCallId: id,
        toolName: 'shot',
        output: {
          type: 'content' as const,
          value: [
            { type: 'text' as const, text: '{"status":"inline"}' },
            { type: 'image-data' as const, data, mediaType: 'image/png' },
          ],
        },
      },
    ],
  });
  const model = () =>
    kaanaLanguageModel({
      target: { kind: 'routingProfile', routingProfile: 'auto' },
      modelId: 'auto',
      surface: 'chat',
    });

  it('sends the latest step’s images in one user message after its tool messages', async () => {
    const result = await model().doGenerate({
      prompt: [...prompt, call('call-1'), shot('call-1', 'AAAA')],
    } as never);

    expect(mocks.requests[0].input).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hola' }] },
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ id: 'call-1', name: 'shot', arguments: '{}' }],
      },
      {
        role: 'tool',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: `{"status":"inline"}\n${TOOL_IMAGE_FOLLOWS_NOTE}` }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'The image shot returned (call call-1):' },
          { type: 'image', source: { kind: 'inline', mediaType: 'image/png', data: 'AAAA' } },
        ],
      },
    ]);
    expect(result.warnings).toHaveLength(0);
  });

  it('does not repeat an earlier step’s image', async () => {
    await model().doGenerate({
      prompt: [
        ...prompt,
        call('call-1'),
        shot('call-1', 'AAAA'),
        call('call-2'),
        shot('call-2', 'BBBB'),
      ],
    } as never);

    const input = mocks.requests[0].input as Array<{ role: string; content: unknown[] }>;
    expect(input[2]).toEqual({
      role: 'tool',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: `{"status":"inline"}\n${PAST_TOOL_IMAGE_NOTE}` }],
    });
    const images = input.flatMap((message) =>
      message.content.filter((part) => (part as { type: string }).type === 'image'),
    );
    expect(images).toEqual([
      { type: 'image', source: { kind: 'inline', mediaType: 'image/png', data: 'BBBB' } },
    ]);
    expect(input.at(-1)?.role).toBe('user');
  });
});
