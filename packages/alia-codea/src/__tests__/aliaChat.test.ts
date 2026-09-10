import { describe, expect, it } from 'vitest';
import {
  AliaChatError,
  completedToolCalls,
  createSseFrameReader,
  interpretFrame,
  isSyntheticCompletion,
  mergeToolCallDeltas,
  streamAliaChat,
  type AliaStreamEvent,
  type StreamedToolCall,
} from '../aliaChat';

/**
 * The stream client reads what the server actually writes.
 *
 * The frames below are the exact byte shapes of `packages/api/src/lib/chat/
 * stream-runner.ts`, `provider-loop.ts`, `sse-writer.ts` and
 * `streaming-helpers.ts`: the early `: keep-alive` comment, OpenAI-shaped
 * `data:` chunks, `event:`-named product events, the `alia_meta.synthetic`
 * stand-in, the in-stream error envelope and `[DONE]`. A fixture invented from
 * the client's own types would agree with the client by construction.
 *
 * The split-at-every-offset case is the one that matters most: the `openai`
 * package's parser is correct about boundaries but drops every named event,
 * and the hand-rolled reader the `@codea` participant used to carry read
 * `data:` lines only and never saw an error frame.
 */

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'r',
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    ...extra,
  })}\n\n`;

const named = (event: string, data: Record<string, unknown>) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const FULL_TURN =
  ': keep-alive\n\n' +
  named('alia.reasoning', { eventVersion: 1, content: 'weighing the options' }) +
  chunk({ content: 'Hel' }) +
  ': keepalive\n\n' +
  chunk({ content: 'lo — ' }) +
  chunk({
    tool_calls: [{ index: 0, id: 'call-fs', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }],
  }) +
  chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"README.md"}' } }] }) +
  named('alia.tool_result', {
    eventVersion: 1,
    tool_call_id: 'call-fs',
    name: 'read_file',
    output: { _originalToolName: 'read_file', params: { path: 'README.md' } },
  }) +
  named('alia.title', { eventVersion: 1, title: 'Readme', conversationId: 'c1' }) +
  chunk({}, {}, 'stop') +
  'data: [DONE]\n\n';

function responseOf(text: string, init: { status?: number; chunkSize?: number } = {}): Response {
  const bytes = new TextEncoder().encode(text);
  const size = init.chunkSize ?? bytes.length;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
      controller.close();
    },
  });
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function collect(text: string, chunkSize?: number): Promise<AliaStreamEvent[]> {
  const events: AliaStreamEvent[] = [];
  for await (const event of streamAliaChat({
    baseUrl: 'https://api.example',
    accessToken: 't',
    body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    fetch: async () => responseOf(text, { chunkSize }),
  })) {
    events.push(event);
  }
  return events;
}

describe('createSseFrameReader', () => {
  it('keeps the event name across a chunk boundary and drops it at the blank line', () => {
    const reader = createSseFrameReader();
    expect(reader.push('event: alia.rea')).toEqual([]);
    expect(reader.push('soning\ndata: {"a":1}\n')).toEqual([{ event: 'alia.reasoning', data: '{"a":1}' }]);
    expect(reader.push('\ndata: {"b":2}\n\n')).toEqual([{ event: '', data: '{"b":2}' }]);
  });

  it('strips CR from a CRLF stream and ignores comments', () => {
    const reader = createSseFrameReader();
    expect(reader.push(': keep-alive\r\n\r\ndata: [DONE]\r\n\r\n')).toEqual([{ event: '', data: '[DONE]' }]);
  });
});

describe('interpretFrame', () => {
  it('turns a stand-in chunk into a synthetic event and never into content', () => {
    const frame = { event: '', data: chunk({ content: 'busy' }, { alia_meta: { synthetic: true, retryable: true } }).slice(6).trim() };
    expect(interpretFrame(frame)).toEqual([{ type: 'synthetic', text: 'busy', retryable: true }]);
  });

  it('throws the server error envelope, in both of its spellings', () => {
    try {
      interpretFrame({ event: '', data: '{"error":{"message":"nope","code":"unknown_routing_profile"}}' });
      throw new Error('did not throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AliaChatError);
      expect((error as AliaChatError).code).toBe('unknown_routing_profile');
      expect((error as AliaChatError).status).toBeNull();
    }
    expect(() => interpretFrame({ event: '', data: '{"error":"Authentication required"}' }))
      .toThrowError('Authentication required');
  });

  it('skips a frame that is not JSON and reports [DONE] as null', () => {
    expect(interpretFrame({ event: '', data: 'not json' })).toEqual([]);
    expect(interpretFrame({ event: '', data: '[DONE]' })).toBeNull();
  });
});

describe('streamAliaChat', () => {
  const expected: AliaStreamEvent[] = [
    { type: 'reasoning', text: 'weighing the options' },
    { type: 'content', text: 'Hel' },
    { type: 'content', text: 'lo — ' },
    {
      type: 'tool_calls',
      deltas: [{ index: 0, id: 'call-fs', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] as never,
    },
    { type: 'tool_calls', deltas: [{ index: 0, function: { arguments: 'th":"README.md"}' } }] },
    {
      type: 'tool_result',
      toolCallId: 'call-fs',
      name: 'read_file',
      output: { _originalToolName: 'read_file', params: { path: 'README.md' } },
    },
    { type: 'event', name: 'alia.title', data: { eventVersion: 1, title: 'Readme', conversationId: 'c1' } },
    { type: 'finish', reason: 'stop' },
  ];

  it('yields every event of a full turn, in order, whatever the chunk boundaries', async () => {
    expect(await collect(FULL_TURN)).toEqual(expected);
    for (const size of [1, 2, 3, 7, 13, 64]) {
      expect(await collect(FULL_TURN, size)).toEqual(expected);
    }
  });

  it('posts to /alia/chat with the bearer and stream: true', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const events = streamAliaChat({
      baseUrl: 'https://api.example',
      accessToken: 'tok',
      body: { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096 },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return responseOf('data: [DONE]\n\n');
      },
    });
    // Drain the stream so the fetch runs; the frames are not the point here.
    for await (const event of events) void event;
    expect(calls[0].url).toBe('https://api.example/alia/chat');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 4096,
      stream: true,
    });
  });

  it('throws the response error for a refused request, with its status and code', async () => {
    const attempt = streamAliaChat({
      baseUrl: 'u',
      accessToken: 't',
      body: { model: 'm', messages: [] },
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'Upgrade your plan to use this model.', code: 'MODEL_NOT_IN_PLAN' } }), {
          status: 403,
        }),
    });
    await expect(attempt.next()).rejects.toMatchObject({
      name: 'AliaChatError',
      status: 403,
      code: 'MODEL_NOT_IN_PLAN',
      message: 'Upgrade your plan to use this model.',
    });
  });

  it('names the status when a refusal body is not JSON', async () => {
    const attempt = streamAliaChat({
      baseUrl: 'u',
      accessToken: 't',
      body: { model: 'm', messages: [] },
      fetch: async () => new Response('<html>gateway timeout</html>', { status: 504 }),
    });
    await expect(attempt.next()).rejects.toMatchObject({ status: 504, retryable: true });
  });

  it('surfaces an in-stream error frame as a thrown error after the content before it', async () => {
    const text = chunk({ content: 'partial' }) + 'data: {"error":{"message":"Insufficient credits","code":"insufficient_credits"}}\n\ndata: [DONE]\n\n';
    const events: AliaStreamEvent[] = [];
    let thrown: unknown = null;
    try {
      for await (const event of streamAliaChat({
        baseUrl: 'u',
        accessToken: 't',
        body: { model: 'm', messages: [] },
        fetch: async () => responseOf(text),
      })) events.push(event);
    } catch (error) {
      thrown = error;
    }
    expect(events).toEqual([{ type: 'content', text: 'partial' }]);
    expect(thrown).toBeInstanceOf(AliaChatError);
    expect((thrown as AliaChatError).code).toBe('insufficient_credits');
  });

  it('stops at [DONE] even when bytes follow it', async () => {
    const text = chunk({ content: 'a' }) + 'data: [DONE]\n\n' + chunk({ content: 'ghost' });
    expect(await collect(text)).toEqual([{ type: 'content', text: 'a' }]);
  });

  it('rejects with AbortError when the signal fires', async () => {
    const controller = new AbortController();
    const attempt = streamAliaChat({
      baseUrl: 'u',
      accessToken: 't',
      body: { model: 'm', messages: [] },
      signal: controller.signal,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    const pending = attempt.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('mergeToolCallDeltas', () => {
  it('assembles a call from its fragments and reports only the whole ones', () => {
    const calls: StreamedToolCall[] = [];
    mergeToolCallDeltas(calls, [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"p' } }]);
    mergeToolCallDeltas(calls, [{ index: 0, function: { arguments: 'ath":"x"}' } }]);
    mergeToolCallDeltas(calls, [{ index: 2, function: { arguments: '{}' } }]);
    expect(calls[0]).toEqual({ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } });
    expect(completedToolCalls(calls)).toEqual([calls[0]]);
  });
});

describe('isSyntheticCompletion', () => {
  it('recognises the stand-in envelope of a non-streaming completion', () => {
    // `buildCompletionResponse` with `aliaMeta: { synthetic: true, retryable: true }`.
    expect(
      isSyntheticCompletion({
        object: 'chat.completion',
        choices: [{ message: { role: 'assistant', content: "I'm sorry, all models are currently busy." } }],
        alia_meta: { synthetic: true, retryable: true },
      }),
    ).toBe(true);
    expect(isSyntheticCompletion({ object: 'chat.completion', choices: [{ message: { content: 'x' } }] })).toBe(false);
    expect(isSyntheticCompletion(null)).toBe(false);
  });
});
