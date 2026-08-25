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
    toolCalls: [] as Array<{ id: string; name: string; arguments: string }>,
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

import { inferenceMessageSchema } from '@oxyhq/contracts';

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

/**
 * Tools, in both directions.
 *
 * Alia's chat is a tool loop, so every one of these mistakes ends the same way
 * — a model that appears to ignore its tools — while looking like nothing is
 * wrong at the seam. The two vocabularies disagree structurally in three
 * places, and each disagreement gets a case here.
 */
describe('tools, on the way out', () => {
  const weather = {
    type: 'function' as const,
    name: 'get_weather',
    description: 'Look up the weather',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
  };

  it('sends a function tool with its schema under the name the contract uses', async () => {
    await model.doGenerate({ prompt: userText('weather?'), tools: [weather] } as never);
    expect(H.sent?.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Look up the weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
  });

  it('declares an empty tool list rather than omitting the field', async () => {
    // The contract distinguishes "this call offers no tools" from "this field
    // was forgotten", and only the first is ever true here.
    await model.doGenerate({ prompt: userText('hi') } as never);
    expect(H.sent?.tools).toEqual([]);
    expect(H.sent).not.toHaveProperty('toolChoice');
  });

  it('translates the one tool choice whose shape differs', async () => {
    await model.doGenerate({
      prompt: userText('hi'),
      tools: [weather],
      toolChoice: { type: 'tool', toolName: 'get_weather' },
    } as never);
    expect(H.sent?.toolChoice).toEqual({ type: 'function', name: 'get_weather' });

    await model.doGenerate({ prompt: userText('hi'), tools: [weather], toolChoice: { type: 'required' } } as never);
    expect(H.sent?.toolChoice).toBe('required');
  });

  it('refuses a provider-defined tool instead of offering one nothing can run', async () => {
    // Kaana routes across providers, so a tool defined by one of them is not a
    // tool this request can honour. Sending it would advertise a capability
    // that fails only once the model tries to use it.
    const result = await model.doGenerate({
      prompt: userText('hi'),
      tools: [weather, { type: 'provider-defined', id: 'openai.file_search', name: 'file_search', args: {} }],
    } as never);

    expect((H.sent?.tools as unknown[]).map((t) => (t as { name: string }).name)).toEqual(['get_weather']);
    expect(result.warnings?.some((w) => JSON.stringify(w).includes('file_search'))).toBe(true);
  });
});

describe('the shape the answer must take', () => {
  /**
   * `generateObject` asks for a shape through `responseFormat` and through
   * nothing else, so a factory that drops it turns "answer in this schema" into
   * "answer however you like, and I will check afterwards".
   *
   * The failure it produced is why these are here rather than in a review
   * comment: `routes/suggestions.ts` asked a reasoning model for eight JSON
   * objects, got prose-free but TRUNCATED JSON back, and answered 500. Sending
   * the schema is not what fixes truncation, but a request that never carried
   * the schema cannot be said to have asked for JSON at all.
   */
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  } as const;

  it('sends a named schema when the caller supplied one', async () => {
    await model.doGenerate({
      prompt: userText('hi'),
      responseFormat: { type: 'json', schema, name: 'reply' },
    } as never);

    expect(H.sent?.responseFormat).toEqual({
      type: 'json_schema',
      name: 'reply',
      schema,
      // Never `true`: the OpenAI dialect's strict mode requires every property
      // to be required, and the AI SDK derives schemas from Zod objects that
      // have optional ones. `true` would have upstreams refuse the schemas this
      // field exists to carry.
      strict: false,
    });
  });

  it('asks for JSON without a shape when there is no schema to send', async () => {
    // The contract keeps `json_object` and `json_schema` apart because a model
    // can answer in valid JSON without being able to honour a schema. Asking
    // for the stricter one here would refuse calls Kaana serves.
    await model.doGenerate({ prompt: userText('hi'), responseFormat: { type: 'json' } } as never);
    expect(H.sent?.responseFormat).toEqual({ type: 'json_object' });
  });

  it('names the output when the caller did not', async () => {
    await model.doGenerate({ prompt: userText('hi'), responseFormat: { type: 'json', schema } } as never);
    expect(H.sent?.responseFormat).toMatchObject({ type: 'json_schema', name: 'response' });
  });

  it('omits the field entirely for the calls that want prose', async () => {
    // Both spellings of "text", because `undefined` is what every existing
    // caller sends and `{type:'text'}` is what the SDK sends when a caller
    // says so explicitly. Emitting `{type:'text'}` on the wire would be a
    // response format on every chat turn in the product.
    await model.doGenerate({ prompt: userText('hi') } as never);
    expect(H.sent).not.toHaveProperty('responseFormat');

    await model.doGenerate({ prompt: userText('hi'), responseFormat: { type: 'text' } } as never);
    expect(H.sent).not.toHaveProperty('responseFormat');
  });

  it('carries it on the streaming path too', async () => {
    // `doStream` builds its payload through the same function, and this is the
    // assertion that says so — `streamObject` would otherwise be asking for a
    // shape that only the non-streaming path sends.
    H.events = [];
    await drain((await model.doStream({
      prompt: userText('hi'),
      responseFormat: { type: 'json', schema, name: 'reply' },
    } as never)).stream);

    expect(H.sent?.responseFormat).toMatchObject({ type: 'json_schema', name: 'reply' });
  });
});

describe('a tool round trip, in the prompt', () => {
  const round = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'weather in Madrid?' }] },
    {
      role: 'assistant' as const,
      content: [{ type: 'tool-call' as const, toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Madrid' } }],
    },
    {
      role: 'tool' as const,
      content: [
        { type: 'tool-result' as const, toolCallId: 'call_1', toolName: 'get_weather', output: { type: 'json' as const, value: { c: 31 } } },
        { type: 'tool-result' as const, toolCallId: 'call_2', toolName: 'get_time', output: { type: 'text' as const, value: '14:00' } },
      ],
    },
  ];

  const sentMessages = (): Array<Record<string, unknown>> =>
    (H.sent?.input as { messages: Array<Record<string, unknown>> }).messages;

  it('moves the assistant\'s tool calls from content parts onto the message', async () => {
    // The AI SDK carries them as content; the contract carries them as a field,
    // OpenAI-style. A turn that only calls tools therefore has EMPTY content,
    // which the contract's own schema accepts.
    await model.doGenerate({ prompt: round } as never);
    expect(sentMessages()[1]).toEqual({
      role: 'assistant',
      content: [],
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Madrid"}' }],
    });
  });

  it('splits one grouped tool message into one message per answered call', async () => {
    // `toolCallId` is per-message in the contract and required on exactly this
    // role, so folding two answers into one message would need one id for both
    // — and the model would have no way to tell which answer belongs to which
    // call.
    await model.doGenerate({ prompt: round } as never);
    expect(sentMessages().slice(2)).toEqual([
      { role: 'tool', content: [{ type: 'text', text: '{"c":31}' }], toolCallId: 'call_1' },
      { role: 'tool', content: [{ type: 'text', text: '14:00' }], toolCallId: 'call_2' },
    ]);
  });

  it('says a denied call was denied rather than answering it with nothing', async () => {
    // An empty result reads as a tool that ran and returned nothing, which
    // invites the model to call it again.
    await model.doGenerate({
      prompt: [
        {
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: 'c', toolName: 't', output: { type: 'execution-denied', reason: 'no consent' } }],
        },
      ],
    } as never);
    expect(JSON.stringify(sentMessages()[0])).toContain('no consent');
  });

  it('sends messages the contract itself accepts', async () => {
    // The strongest available check on this translation, because it is the only
    // one that does not re-implement it: the schema here is the same object
    // Kaana validates against on the other side of the wire. A negative control
    // sits below it, so a schema that accepted anything would be visible.
    await model.doGenerate({ prompt: round } as never);
    for (const message of sentMessages()) {
      const parsed = inferenceMessageSchema.safeParse(message);
      expect(parsed.success, JSON.stringify(message)).toBe(true);
    }
    // Negative control: the same schema refuses a tool answer with no call.
    expect(inferenceMessageSchema.safeParse({ role: 'tool', content: [{ type: 'text', text: 'x' }] }).success).toBe(false);
  });
});

describe('tools, on the way back', () => {
  it('returns tool calls as content and finishes as a tool round', async () => {
    // Several upstreams end a tool call with `stop`. The SDK's agent loop reads
    // the unified reason to decide whether there is a round to run, so passing
    // `stop` through would end the conversation holding an unanswered call —
    // and the provider's own word survives in `raw`.
    H.completion = {
      ...H.completion,
      outputText: '',
      reasoningText: '',
      finishReason: 'stop',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Madrid"}' }],
    };
    const result = await model.doGenerate({ prompt: userText('weather?') } as never);

    expect(result.content).toEqual([
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: '{"city":"Madrid"}' },
    ]);
    expect(result.finishReason).toEqual({ unified: 'tool-calls', raw: 'stop' });
    H.completion = { ...H.completion, toolCalls: [] };
  });

  it('streams a tool call as start, deltas, end and the call itself', async () => {
    H.events = [
      { type: 'tool_call', toolCallId: 'call_1', name: 'get_weather', argumentsDelta: '{"city"', complete: false },
      { type: 'tool_call', toolCallId: 'call_1', argumentsDelta: ':"Madrid"}', complete: true },
      { type: 'done', finishReason: 'tool_calls' },
    ];
    const parts = await drain((await model.doStream({ prompt: userText('hi') } as never)).stream) as Array<Record<string, unknown>>;

    expect(parts.map((p) => p.type)).toEqual([
      'stream-start', 'tool-input-start', 'tool-input-delta', 'tool-input-delta', 'tool-input-end', 'tool-call', 'finish',
    ]);
    expect(parts.find((p) => p.type === 'tool-call')).toEqual({
      type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: '{"city":"Madrid"}',
    });
  });

  it('waits for the name before opening the block, and flushes what it held', async () => {
    // A `tool-input-start` naming the empty string is a lie a consumer acts on,
    // so deltas that arrive first are buffered rather than emitted against a
    // name nobody sent yet.
    H.events = [
      { type: 'tool_call', toolCallId: 'c', argumentsDelta: '{"a"', complete: false },
      { type: 'tool_call', toolCallId: 'c', name: 'f', argumentsDelta: ':1}', complete: true },
      { type: 'done', finishReason: 'tool_calls' },
    ];
    const parts = await drain((await model.doStream({ prompt: userText('hi') } as never)).stream) as Array<Record<string, unknown>>;

    const start = parts.findIndex((p) => p.type === 'tool-input-start');
    expect(start).toBeGreaterThan(-1);
    expect((parts[start] as { toolName: string }).toolName).toBe('f');
    expect(parts.filter((p) => p.type === 'tool-input-delta').map((p) => p.delta)).toEqual(['{"a"', ':1}']);
    expect((parts.find((p) => p.type === 'tool-call') as { input: string }).input).toBe('{"a":1}');
  });

  it('closes a call the stream never completed', async () => {
    // Leaving the block open hands a consumer a `tool-input-start` with no end,
    // which hangs. Emitting the truncated arguments instead surfaces as an
    // unparseable tool input, which is what actually happened.
    H.events = [
      { type: 'tool_call', toolCallId: 'c', name: 'f', argumentsDelta: '{"a"', complete: false },
      { type: 'done', finishReason: 'length' },
    ];
    const parts = await drain((await model.doStream({ prompt: userText('hi') } as never)).stream) as Array<Record<string, unknown>>;

    expect(parts.map((p) => p.type)).toContain('tool-input-end');
    expect((parts.find((p) => p.type === 'tool-call') as { input: string }).input).toBe('{"a"');
    expect((parts.at(-1) as { finishReason: { unified: string; raw: string } }).finishReason).toEqual({
      unified: 'tool-calls', raw: 'length',
    });
  });
});
