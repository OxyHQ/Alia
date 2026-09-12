import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requests: [] as Array<Record<string, unknown>>,
  options: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
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
        usage: [{ unit: 'input_tokens', quantity: 2 }, { unit: 'output_tokens', quantity: 1 }],
      };
    },
    stream: (request: Record<string, unknown>, options: Record<string, unknown>) => {
      mocks.requests.push(request);
      mocks.options.push(options);
      return (async function* () {
        for (const event of mocks.events) yield event;
      })();
    },
  }),
}));

import { kaanaLanguageModel } from '../kaana-language-model.js';
import { OxyInferenceError } from '@oxy.so/core';
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
  });

  it.each([
    ['rate_limited', true, 1250, 'RATE_LIMITED', 2],
    ['provider_billing_refused', false, undefined, 'PROVIDER_UNAVAILABLE', undefined],
    ['provider_credential_invalid', false, undefined, 'PROVIDER_UNAVAILABLE', undefined],
    ['no_route_available', false, undefined, 'PROVIDER_UNAVAILABLE', undefined],
    ['provider_timeout', true, undefined, 'TIMEOUT', undefined],
    ['quota_exceeded', false, undefined, 'QUOTA_EXCEEDED', undefined],
  ] as const)('preserves %s through the stream and product classification', async (code, retryable, retryAfterMs, productCode, retryAfter) => {
    mocks.events.push({
      type: 'error', requestId: 'req-failed',
      error: { code, message: 'Upstream refused the request.', retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
    });
    const model = kaanaLanguageModel({
      target: { kind: 'routing_profile_id', routingProfileId: '01a06477-94f5-74f0-bc25-628b5f45d802' },
      modelId: 'route:instant', surface: 'chat',
    });
    const { stream } = await model.doStream({ prompt } as never);
    const parts = await drain(stream);
    const failure = parts.find(part => part.type === 'error')?.error;
    expect(failure).toBeInstanceOf(OxyInferenceError);
    expect(failure).toMatchObject({ code, retryable, requestId: 'req-failed' });
    const productError = toAliaError(failure);
    expect(productError).toMatchObject({ code: productCode, retryable });
    expect(productError.retryAfter).toBe(retryAfter);
    expect(productError.httpStatus).toBeGreaterThanOrEqual(400);
    expect(productError.userMessage).not.toContain('Upstream');
    expect(parts.filter(part => part.type === 'error')).toHaveLength(1);
    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: { unified: 'error', raw: code } });
  });

  it('sends an exact routing profile and delegated user to Oxy', async () => {
    const model = kaanaLanguageModel({
      target: {
        kind: 'routing_profile_id',
        routingProfileId: '01a06477-94f5-74f0-bc25-628b5f45d802',
      },
      modelId: 'route:thinking',
      surface: 'chat',
      oxyUserId: 'user-id',
    });
    const result = await model.doGenerate({ prompt, maxOutputTokens: 128 } as never);

    expect(mocks.requests[0]).toMatchObject({
      routingProfileId: '01a06477-94f5-74f0-bc25-628b5f45d802',
      maxOutputTokens: 128,
      labels: { 'alia.surface': 'chat' },
    });
    expect(mocks.requests[0]).not.toHaveProperty('model');
    expect(mocks.requests[0]).not.toHaveProperty('routingProfile');
    expect(mocks.options[0]).toMatchObject({ delegatedUserId: 'user-id' });
    expect(result.content).toEqual([{ type: 'text', text: 'hola' }]);
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
      target: { kind: 'routing_profile_id', routingProfileId: '01a06477-94f5-74f0-bc25-628b5f45d802' },
      modelId: 'route:auto',
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
      target: { kind: 'routing_profile_id', routingProfileId: '01a06477-94f5-74f0-bc25-628b5f45d802' },
      modelId: 'route:auto',
      surface: 'chat',
    });
    const result = await model.doGenerate({ prompt } as never);

    expect(result.providerMetadata).toEqual({ kaana: { resolvedModelReference: 'openai/gpt-5-mini@2026-08-18' } });
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
      target: { kind: 'routing_profile_id', routingProfileId: '01a06477-94f5-74f0-bc25-4c5c13b93ccd' },
      modelId: 'route:auto',
      surface: 'chat',
    });
    const parts = await drain((await model.doStream({ prompt } as never)).stream);

    const metadata = parts.find((part) => part.type === 'response-metadata');
    expect(metadata).toMatchObject({ id: 'req-2', modelId: 'anthropic/claude-sonnet-4@2026-08-18' });
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
      target: { kind: 'routing_profile_id', routingProfileId: '01a06477-94f5-74f0-bc25-4c5c13b93ccd' },
      modelId: 'route:auto',
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
      target: {
        kind: 'routing_profile_id',
        routingProfileId: '01a06477-94f5-74f0-bc25-4c5c13b93ccd',
      },
      modelId: 'route:auto',
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
});
