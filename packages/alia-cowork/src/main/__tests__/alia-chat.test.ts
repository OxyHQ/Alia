import { describe, expect, it } from 'vitest';
import {
  AliaChatError,
  completedToolCalls,
  failureDetail,
  isCreditsRefusal,
  mergeToolCallDeltas,
  streamAliaChat,
  withFailureDetail,
  type AliaChatRequestBody,
  type AliaStreamEvent,
  type StreamedToolCall,
} from '../alia-chat';

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
 * The split-at-every-offset case is the one that matters most: the previous
 * consumer was the `openai` package, whose parser is correct about boundaries
 * but drops every named event, and the hand-rolled readers in sibling
 * packages were correct about events but forgot the name across a boundary.
 */

const chunk = (
  delta: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  finish: string | null = null,
) =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'r',
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    ...extra,
  })}\n\n`;

const named = (event: string, data: Record<string, unknown>) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const FULL_TURN =
  ': keep-alive\n\n' +
  named('alia.reasoning', { eventVersion: 1, content: 'weighing the options' }) +
  chunk({ content: 'Hel' }) +
  ': keepalive\n\n' +
  chunk({ content: 'lo — ' }) +
  chunk({
    tool_calls: [
      {
        index: 0,
        id: 'call-fs',
        type: 'function',
        function: { name: 'read_file', arguments: '{"pa' },
      },
    ],
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
      for (let at = 0; at < bytes.length; at += size)
        controller.enqueue(bytes.slice(at, at + size));
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

    body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    fetch: async () => responseOf(text, { chunkSize }),
  })) {
    events.push(event);
  }
  return events;
}

describe('streamAliaChat', () => {
  const expected: AliaStreamEvent[] = [
    { type: 'reasoning', text: 'weighing the options' },
    { type: 'content', text: 'Hel' },
    { type: 'content', text: 'lo — ' },
    {
      type: 'tool_calls',
      deltas: [
        {
          index: 0,
          id: 'call-fs',
          type: 'function',
          function: { name: 'read_file', arguments: '{"pa' },
        },
      ] as never,
    },
    { type: 'tool_calls', deltas: [{ index: 0, function: { arguments: 'th":"README.md"}' } }] },
    {
      type: 'tool_result',
      toolCallId: 'call-fs',
      name: 'read_file',
      output: { _originalToolName: 'read_file', params: { path: 'README.md' } },
    },
    {
      type: 'event',
      name: 'alia.title',
      data: { eventVersion: 1, title: 'Readme', conversationId: 'c1' },
    },
    { type: 'finish', reason: 'stop' },
  ];

  it('yields every event of a full turn, in order', async () => {
    expect(await collect(FULL_TURN)).toEqual(expected);
  });

  it('yields the same events whatever the chunk boundaries', async () => {
    // Every offset up to the frame length is a different boundary set. The
    // multi-byte dash in the content is what `{ stream: true }` decoding is for.
    for (const size of [1, 2, 3, 7, 13, 64]) {
      expect(await collect(FULL_TURN, size)).toEqual(expected);
    }
  });

  it('posts to /alia/chat with the bearer and stream: true', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const events = streamAliaChat({
      baseUrl: 'https://api.example',

      body: { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return responseOf('data: [DONE]\n\n');
      },
    });
    // Drain the stream so the fetch runs; the frames are not the point here.
    for await (const event of events) void event;
    expect(calls[0].url).toBe('https://api.example/alia/chat');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      stream: true,
    });
  });

  it('throws the response error for a refused request, with its status and code', async () => {
    const attempt = streamAliaChat({
      baseUrl: 'u',

      body: { model: 'm', messages: [] },
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: { message: 'Upgrade your plan to use this model.', code: 'MODEL_NOT_IN_PLAN' },
          }),
          {
            status: 403,
          },
        ),
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

      body: { model: 'm', messages: [] },
      fetch: async () => new Response('<html>gateway timeout</html>', { status: 504 }),
    });
    await expect(attempt.next()).rejects.toMatchObject({
      status: 504,
      retryable: true,
      message: 'Alia API error (HTTP 504).',
    });
  });

  it('surfaces an in-stream error frame as a thrown error after the content before it', async () => {
    const text =
      chunk({ content: 'partial' }) +
      'data: {"error":{"message":"Insufficient credits","code":"insufficient_credits"}}\n\ndata: [DONE]\n\n';
    const events: AliaStreamEvent[] = [];
    let thrown: unknown = null;
    try {
      for await (const event of streamAliaChat({
        baseUrl: 'u',

        body: { model: 'm', messages: [] },
        fetch: async () => responseOf(text),
      }))
        events.push(event);
    } catch (error) {
      thrown = error;
    }
    expect(events).toEqual([{ type: 'content', text: 'partial' }]);
    expect(thrown).toBeInstanceOf(AliaChatError);
    expect((thrown as AliaChatError).code).toBe('insufficient_credits');
  });

  it('stops at [DONE] even when bytes follow it', async () => {
    const text = `${chunk({ content: 'a' })}data: [DONE]\n\n${chunk({ content: 'ghost' })}`;
    expect(await collect(text)).toEqual([{ type: 'content', text: 'a' }]);
  });

  it('rejects with AbortError when the signal fires', async () => {
    const controller = new AbortController();
    const attempt = streamAliaChat({
      baseUrl: 'u',

      body: { model: 'm', messages: [] },
      signal: controller.signal,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
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
    mergeToolCallDeltas(calls, [
      { index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"p' } },
    ]);
    mergeToolCallDeltas(calls, [{ index: 0, function: { arguments: 'ath":"x"}' } }]);
    mergeToolCallDeltas(calls, [{ index: 2, function: { arguments: '{}' } }]);
    expect(calls[0]).toEqual({
      id: 'c1',
      type: 'function',
      function: { name: 'read_file', arguments: '{"path":"x"}' },
    });
    // Index 1 was never sent, index 2 has neither id nor name.
    expect(completedToolCalls(calls)).toEqual([calls[0]]);
  });
});

describe('a turn that failed before any output', () => {
  const failure = (retryable: boolean) => ({
    error: {
      message: 'Service temporarily unavailable. Please try again in a moment.',
      type: 'server_error',
      param: null,
      code: 'PROVIDER_UNAVAILABLE',
      retryable,
      reference: 'chatcmpl-ref',
    },
  });

  it('is raised as a typed, retryable error from the stream, past the context event, with nothing rendered', async () => {
    const wire =
      ': keep-alive\n\n' +
      'event: alia.context\ndata: {"eventVersion":1,"conversationId":null}\n\n' +
      `data: ${JSON.stringify(failure(true))}\n\ndata: [DONE]\n\n`;
    const attempt = streamAliaChat({
      baseUrl: 'u',

      body: { model: 'm', messages: [] },
      fetch: async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }),
    });
    const rendered: string[] = [];
    let thrown: unknown = null;
    try {
      for await (const event of attempt) {
        if (event.type === 'content' || event.type === 'synthetic') rendered.push(event.text);
      }
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AliaChatError);
    expect(thrown).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(rendered).toEqual([]);
  });

  it('is raised as a typed error from an HTTP 503 or 500 carrying the same envelope', async () => {
    const run = (status: number, retryable: boolean) =>
      streamAliaChat({
        baseUrl: 'u',

        body: { model: 'm', messages: [] },
        fetch: async () => new Response(JSON.stringify(failure(retryable)), { status }),
      }).next();
    await expect(run(503, true)).rejects.toMatchObject({
      status: 503,
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    await expect(run(500, false)).rejects.toMatchObject({
      status: 500,
      code: 'PROVIDER_UNAVAILABLE',
      retryable: false,
    });
  });
});

describe('a typed failure keeps what support needs, and a cut stream is an error', () => {
  const run = (wire: string) =>
    streamAliaChat({
      baseUrl: 'u',

      body: { model: 'm', messages: [] },
      fetch: async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }),
    });

  it('carries the run reference and formats code and Ref for a person to quote', async () => {
    const wire = `data: ${JSON.stringify({
      error: {
        message: 'Down',
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
        reference: 'chatcmpl-9',
      },
    })}\n\n`;
    const error = await run(wire)
      .next()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AliaChatError);
    expect((error as AliaChatError).reference).toBe('chatcmpl-9');
    expect(failureDetail(error as AliaChatError)).toBe('PROVIDER_UNAVAILABLE · Ref chatcmpl-9');
    expect(withFailureDetail('Down', error as AliaChatError)).toBe(
      'Down (PROVIDER_UNAVAILABLE · Ref chatcmpl-9)',
    );
  });

  it('is out of credits only by a credits code, never by QUOTA_EXCEEDED or the status alone', () => {
    expect(
      isCreditsRefusal(new AliaChatError('x', { status: 402, code: 'INSUFFICIENT_CREDITS' })),
    ).toBe(true);
    expect(isCreditsRefusal(new AliaChatError('x', { status: 402, code: 'QUOTA_EXCEEDED' }))).toBe(
      false,
    );
    expect(isCreditsRefusal(new AliaChatError('x', { status: 402 }))).toBe(true);
  });

  it('throws when the connection closes after content without [DONE] or a finish reason', async () => {
    const seen: AliaStreamEvent[] = [];
    let thrown: unknown = null;
    try {
      for await (const event of run(chunk({ content: 'cut off' }))) seen.push(event);
    } catch (error) {
      thrown = error;
    }
    expect(seen).toEqual([{ type: 'content', text: 'cut off' }]);
    expect(thrown).toMatchObject({ code: 'STREAM_INCOMPLETE', retryable: true });
  });

  it('rejects a finish reason without the shared terminal marker', async () => {
    const wire = chunk({ content: 'whole' }, {}, 'stop').trimEnd();
    await expect(collect(wire)).rejects.toMatchObject({
      code: 'STREAM_INCOMPLETE',
      retryable: true,
    });
  });

  it('surfaces malformed JSON and invalid tool fragments as readable failures', async () => {
    for (const wire of ['data: not json\n\n', chunk({ tool_calls: [{ index: -1 }] })]) {
      await expect(collect(`${wire}data: [DONE]\n\n`)).rejects.toMatchObject({
        code: 'STREAM_INVALID',
        retryable: true,
        message: 'Alia’s response could not be read. Please try again.',
      });
    }
  });

  it('maps a synthetic shared text event without presenting it as an answer', async () => {
    await expect(
      collect(
        chunk({ content: 'busy' }, { alia_meta: { synthetic: true, retryable: true } }) +
          'data: [DONE]\n\n',
      ),
    ).resolves.toEqual([{ type: 'synthetic', text: 'busy', retryable: true }]);
  });

  it('uses the shared CRLF and multi-line SSE framing contract', async () => {
    const wire =
      ': keep-alive\r\n\r\ndata: {"choices":[{\r\ndata: "delta":{"content":"whole"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]';
    await expect(collect(wire)).resolves.toEqual([
      { type: 'content', text: 'whole' },
      { type: 'finish', reason: 'stop' },
    ]);
  });
});

it('preserves multimodal, assistant tool-call and tool-result request bodies through shared parsing', async () => {
  const body: AliaChatRequestBody = {
    turnId: 'bca3a59a-37eb-43ae-a637-9382d2230626',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'owned fixture' },
          { type: 'image_url', image_url: { url: 'https://example.test/owned.png' } },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'tool-1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'tool-1', content: 'owned result' },
    ],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
  };
  let sent: unknown;
  for await (const _event of streamAliaChat({
    baseUrl: 'https://api.example',
    body,
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return responseOf('data: [DONE]\n\n');
    },
  })) {
    /* terminal-only fixture */
  }
  expect(sent).toEqual({ ...body, stream: true });
});
