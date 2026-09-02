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
      target: { kind: 'routing_profile', routingProfile: 'kaana-v1-thinking' },
      surface: 'chat',
      oxyUserId: 'user-id',
    });
    const result = await model.doGenerate({ prompt, maxOutputTokens: 128 } as never);

    expect(mocks.requests[0]).toMatchObject({
      routingProfile: 'kaana-v1-thinking',
      maxOutputTokens: 128,
      labels: { 'alia.surface': 'chat' },
    });
    expect(mocks.requests[0]).not.toHaveProperty('model');
    expect(mocks.options[0]).toMatchObject({ delegatedUserId: 'user-id' });
    expect(result.content).toEqual([{ type: 'text', text: 'hola' }]);
  });

  it('sends a pinned canonical model without guessing from its spelling', async () => {
    const model = kaanaLanguageModel({
      target: { kind: 'model', model: 'openai/gpt-5-mini' },
      surface: 'authoring',
    });
    await model.doGenerate({ prompt } as never);

    expect(mocks.requests[0]).toMatchObject({ model: 'openai/gpt-5-mini' });
    expect(mocks.requests[0]).not.toHaveProperty('routingProfile');
  });

  it('streams through the SDK and keeps usage and finish semantics', async () => {
    mocks.events.push(
      { type: 'delta', channel: 'output_text', text: 'ho' },
      { type: 'usage', units: [{ unit: 'output_tokens', quantity: 1 }] },
      { type: 'done', finishReason: 'stop' },
    );
    const model = kaanaLanguageModel({
      target: { kind: 'routing_profile', routingProfile: 'kaana-v1-fast' },
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
