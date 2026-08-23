import { describe, expect, it, vi } from 'vitest';

/**
 * Kaana wearing the interface twenty-seven modules already consume.
 *
 * These cases are about the TRANSLATION, in both directions, because the whole
 * value of this module is that call sites do not change — which means a mapping
 * mistake shows up as a behaviour change nobody edited. The failures worth
 * catching are all silent ones: a dropped image that produces a confident
 * answer about a question nobody asked, an empty text block on a refusal, a
 * usage figure invented out of a missing measurement.
 */

const H = vi.hoisted(() => ({
  /** What the fake client's `generate` answers. */
  completion: {
    outputText: '',
    reasoningText: '',
    refusalText: '',
    finishReason: 'stop' as string | null,
    usage: [] as Array<{ unit: string; quantity: number }>,
  },
  /** What its `stream` yields. */
  events: [] as Array<Record<string, unknown>>,
  /** The payload the client was handed, for asserting what was SENT. */
  sent: null as Record<string, unknown> | null,
}));

vi.mock('../kaana.js', () => ({
  getKaanaClient: () => ({
    generate: async (call: { payload: Record<string, unknown> }) => {
      H.sent = call.payload;
      return H.completion;
    },
    stream: async function* (call: { payload: Record<string, unknown> }) {
      H.sent = call.payload;
      for (const event of H.events) yield event;
    },
  }),
}));

import { kaanaLanguageModel } from '../kaana-language-model.js';

const model = kaanaLanguageModel({ modelReference: 'auto', surface: 'chat' });

const userText = (text: string) => [
  { role: 'user' as const, content: [{ type: 'text' as const, text }] },
];

async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const parts: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

describe('what it says it is', () => {
  it('names the request, not whatever served it', () => {
    // Which deployment answered is Kaana's routing decision, reported on its
    // own start event. Putting it here would make the SDK's identifier mean
    // something different from call to call.
    expect(model.provider).toBe('kaana');
    expect(model.modelId).toBe('auto');
    expect(model.specificationVersion).toBe('v3');
  });
});

describe('doGenerate', () => {
  it('carries text and reasoning back as separate content blocks', async () => {
    H.completion = { ...H.completion, outputText: 'hola', reasoningText: 'thinking', finishReason: 'stop' };
    const result = await model.doGenerate({ prompt: userText('hi') } as never);

    expect(result.content).toEqual([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'hola' },
    ]);
    expect(result.finishReason).toEqual({ unified: 'stop', raw: 'stop' });
  });

  it('emits no empty block for a channel that said nothing', async () => {
    // An empty text block reads downstream as a model that answered with
    // nothing, which is a different event from one that only reasoned.
    H.completion = { ...H.completion, outputText: '', reasoningText: 'only thought' };
    const result = await model.doGenerate({ prompt: userText('hi') } as never);
    expect(result.content).toEqual([{ type: 'reasoning', text: 'only thought' }]);
  });

  it('reports the tokens it was told and invents the rest as undefined', async () => {
    // A zero would claim a measurement nobody took: the contract reports units,
    // and it has no word for the cache breakdown the SDK asks about.
    H.completion = {
      ...H.completion,
      usage: [{ unit: 'input_tokens', quantity: 13 }, { unit: 'output_tokens', quantity: 2 }, { unit: 'requests', quantity: 1 }],
    };
    const { usage } = await model.doGenerate({ prompt: userText('hi') } as never);

    expect(usage.inputTokens).toEqual({ total: 13, noCache: undefined, cacheRead: undefined, cacheWrite: undefined });
    expect(usage.outputTokens).toEqual({ total: 2, text: undefined, reasoning: undefined });
  });

  it('keeps the provider\'s own word beside the unified one', async () => {
    // `other` meaning "we had no word for this" and `other` meaning "the
    // provider said other" are different facts, and `raw` is what tells them
    // apart.
    H.completion = { ...H.completion, finishReason: 'guardrail_tripped' };
    const { finishReason } = await model.doGenerate({ prompt: userText('hi') } as never);
    expect(finishReason).toEqual({ unified: 'other', raw: 'guardrail_tripped' });
  });

  it('warns about a part it cannot send, and does not send it', async () => {
    // Silently discarding an image produces a confident answer about a question
    // the user did not ask. Kaana serves text today; the warning is what the SDK
    // has for "I could not do this part".
    H.completion = { ...H.completion, outputText: 'ok' };
    const result = await model.doGenerate({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'file', mediaType: 'image/png', data: 'AAAA' },
          ],
        },
      ],
    } as never);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toMatchObject({ type: 'other' });
    const input = H.sent?.input as { messages: Array<{ content: unknown[] }> };
    expect(input.messages[0].content).toEqual([{ type: 'text', text: 'what is this?' }]);
  });
});

describe('doStream', () => {
  it('opens the text block on the first delta and closes it once', async () => {
    H.events = [
      { type: 'start' },
      { type: 'delta', channel: 'output_text', text: 'Ho' },
      { type: 'delta', channel: 'output_text', text: 'la' },
      { type: 'usage', units: [{ unit: 'output_tokens', quantity: 2 }] },
      { type: 'done', finishReason: 'stop' },
    ];
    const { stream } = await model.doStream({ prompt: userText('hi') } as never);
    const parts = await drain(stream) as Array<Record<string, unknown>>;

    expect(parts.map((p) => p.type)).toEqual([
      'stream-start', 'text-start', 'text-delta', 'text-delta', 'text-end', 'finish',
    ]);
    expect(parts.filter((p) => p.type === 'text-delta').map((p) => p.delta)).toEqual(['Ho', 'la']);
    const finish = parts.at(-1) as { finishReason: unknown; usage: { outputTokens: { total: number } } };
    expect(finish.finishReason).toEqual({ unified: 'stop', raw: 'stop' });
    expect(finish.usage.outputTokens.total).toBe(2);
  });

  it('opens no text block when nothing was said', async () => {
    // The pair is what a consumer counts on: an unmatched `text-start` on a
    // refusal reads as an answer that was empty rather than declined.
    H.events = [{ type: 'start' }, { type: 'done', finishReason: 'content_filter' }];
    const { stream } = await model.doStream({ prompt: userText('hi') } as never);
    const parts = await drain(stream) as Array<Record<string, unknown>>;

    expect(parts.map((p) => p.type)).toEqual(['stream-start', 'finish']);
    expect((parts.at(-1) as { finishReason: unknown }).finishReason).toEqual({
      unified: 'content-filter',
      raw: 'content_filter',
    });
  });

  it('keeps reasoning in its own block', async () => {
    H.events = [
      { type: 'delta', channel: 'reasoning', text: 'hmm' },
      { type: 'delta', channel: 'output_text', text: 'yes' },
      { type: 'done', finishReason: 'stop' },
    ];
    const { stream } = await model.doStream({ prompt: userText('hi') } as never);
    const parts = await drain(stream) as Array<Record<string, unknown>>;

    expect(parts.map((p) => p.type)).toEqual([
      'stream-start', 'reasoning-start', 'reasoning-delta', 'text-start', 'text-delta',
      'reasoning-end', 'text-end', 'finish',
    ]);
  });

  it('turns an error event into an error part and an error finish', async () => {
    H.events = [
      { type: 'delta', channel: 'output_text', text: 'partial' },
      { type: 'error', error: { message: 'upstream said no', code: 'provider_unavailable' } },
    ];
    const { stream } = await model.doStream({ prompt: userText('hi') } as never);
    const parts = await drain(stream) as Array<Record<string, unknown>>;

    expect(parts.map((p) => p.type)).toContain('error');
    const finish = parts.at(-1) as { type: string; finishReason: unknown };
    expect(finish.type).toBe('finish');
    expect(finish.finishReason).toEqual({ unified: 'error', raw: 'provider_unavailable' });
  });
});
