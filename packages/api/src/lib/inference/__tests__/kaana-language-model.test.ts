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
