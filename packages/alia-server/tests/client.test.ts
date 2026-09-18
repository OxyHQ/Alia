import { describe, expect, it, vi } from 'vitest';
import {
  AliaRequestError,
  AliaServerClient,
  AliaStreamError,
  readAliaEventStream,
  type AliaStreamEvent,
} from '../src/index.js';
import { aliaStream, sseResponse } from './wire.js';

const TOKEN = 'oxy-product-service-token';

function clientFor(response: Response | (() => Promise<Response>)): {
  client: AliaServerClient;
  fetchClient: ReturnType<typeof vi.fn>;
} {
  const fetchClient = vi.fn(
    typeof response === 'function' ? response : async () => response,
  ) as unknown as ReturnType<typeof vi.fn>;
  const client = new AliaServerClient({
    baseUrl: 'https://api.alia.onl/',
    token: TOKEN,
    fetch: fetchClient as unknown as typeof fetch,
  });
  return { client, fetchClient };
}

async function collect(stream: AsyncIterable<AliaStreamEvent>): Promise<AliaStreamEvent[]> {
  const events: AliaStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const turn = { messages: [{ role: 'user' as const, content: 'Hola' }] };

describe('AliaServerClient — the request', () => {
  it('posts one streaming turn to the product path with the bearer and extra headers', async () => {
    const wire = aliaStream();
    wire.text('ok');
    wire.stop();
    wire.done();
    const { client, fetchClient } = clientFor(sseResponse(wire.wire()));

    await collect(
      await client.stream(
        { agentId: 'agent-id', messages: turn.messages },
        { headers: { 'X-Oxy-Requester-Assertion': 'one-use-assertion' } },
      ),
    );

    expect(fetchClient).toHaveBeenCalledTimes(1);
    const [url, init] = fetchClient.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.alia.onl/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
      'X-Oxy-Requester-Assertion': 'one-use-assertion',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      agentId: 'agent-id',
      messages: turn.messages,
      stream: true,
    });
  });

  it('calls the header function once per turn, because a one-use header cannot be cached', async () => {
    let minted = 0;
    const client = new AliaServerClient({
      baseUrl: 'https://api.alia.onl',
      token: async () => TOKEN,
      headers: () => ({ 'X-Oxy-Requester-Assertion': `assertion-${(minted += 1)}` }),
      fetch: (async () => {
        const wire = aliaStream();
        wire.text('ok');
        wire.done();
        return sseResponse(wire.wire());
      }) as unknown as typeof fetch,
    });

    await collect(await client.stream(turn));
    await collect(await client.stream(turn));
    expect(minted).toBe(2);
  });

  it('never lets a caller turn streaming off through `extra`', async () => {
    const wire = aliaStream();
    wire.done();
    const { client, fetchClient } = clientFor(sseResponse(wire.wire()));

    await collect(await client.stream({ ...turn, extra: { stream: false, temperature: 0.2 } }));

    const [, init] = fetchClient.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ stream: true, temperature: 0.2 });
  });

  it('throws a typed error for a non-2xx answer, carrying the code and none of the prose', async () => {
    const { client } = clientFor(
      Response.json(
        { code: 'SERVICE_ACTING_AS_UNAUTHORIZED', message: 'private upstream detail' },
        { status: 403 },
      ),
    );

    const error = await client.stream(turn).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AliaRequestError);
    expect(error).toMatchObject({ name: 'AliaRequestError', status: 403, code: 'SERVICE_ACTING_AS_UNAUTHORIZED' });
    expect(JSON.stringify(error)).not.toContain('private upstream detail');
    expect(String((error as Error).message)).not.toContain('private upstream detail');
  });

  it('reports a non-2xx with an unreadable body as a status and a null code', async () => {
    const { client } = clientFor(new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    await expect(client.stream(turn)).rejects.toMatchObject({
      name: 'AliaRequestError',
      status: 502,
      code: null,
    });
  });

  it('refuses a 200 that is not an event stream', async () => {
    const { client } = clientFor(Response.json({ choices: [] }, { status: 200 }));
    await expect(client.stream(turn)).rejects.toMatchObject({
      name: 'AliaStreamError',
      failure: 'not_event_stream',
      shape: { valueType: 'application/json' },
    });
  });
});

describe('AliaServerClient — the stream the API actually writes', () => {
  it('yields every text delta verbatim, then the finish and the terminator', async () => {
    const wire = aliaStream();
    wire.text('Aquí tienes. <PROPERTIES_JSON>["0199bb4e-');
    wire.text('0341-725e-a905-11001c3659b4"]</PROPERTIES_JSON>');
    wire.stop();
    wire.done();
    const { client } = clientFor(sseResponse(wire.wire()));

    const events = await collect(await client.stream(turn));
    expect(events).toEqual([
      { type: 'text', text: 'Aquí tienes. <PROPERTIES_JSON>["0199bb4e-' },
      { type: 'text', text: '0341-725e-a905-11001c3659b4"]</PROPERTIES_JSON>' },
      { type: 'finish', reason: 'stop' },
      { type: 'done' },
    ]);
  });

  it('survives byte boundaries that fall anywhere, including mid-multibyte', async () => {
    const wire = aliaStream();
    wire.text('Aquí');
    wire.text(' tienes');
    wire.stop();
    wire.done();
    const raw = wire.wire();
    const length = new TextEncoder().encode(raw).length;
    const slices = Array.from({ length: length - 1 }, (_, index) => index + 1);
    const { client } = clientFor(sseResponse(raw, { slices }));

    const text = (await collect(await client.stream(turn)))
      .filter((event): event is Extract<AliaStreamEvent, { type: 'text' }> => event.type === 'text')
      .map((event) => event.text)
      .join('');
    expect(text).toBe('Aquí tienes');
  });

  it('surfaces a named product event mid-stream without interpreting it', async () => {
    const wire = aliaStream();
    wire.agentTurn({ eventVersion: 1, turnId: 'turn-1', agentId: 'a', conversationId: null });
    wire.text('one');
    wire.event('alia.tool_result', { eventVersion: 1, toolName: 'searchWeb', output: { hits: 2 } });
    wire.text('two');
    wire.stop();
    wire.done();
    const { client } = clientFor(sseResponse(wire.wire()));

    expect(await collect(await client.stream(turn))).toEqual([
      {
        type: 'event',
        event: 'alia.agent_turn',
        data: { eventVersion: 1, turnId: 'turn-1', agentId: 'a', conversationId: null },
      },
      { type: 'text', text: 'one' },
      {
        type: 'event',
        event: 'alia.tool_result',
        data: { eventVersion: 1, toolName: 'searchWeb', output: { hits: 2 } },
      },
      { type: 'text', text: 'two' },
      { type: 'finish', reason: 'stop' },
      { type: 'done' },
    ]);
  });

  it('turns an in-stream error payload into an error event carrying the server code', async () => {
    const wire = aliaStream();
    wire.error({ message: 'The agent is unavailable.', type: 'server_error', code: 'agent_unavailable' });
    const { client } = clientFor(sseResponse(wire.wire()));

    expect(await collect(await client.stream(turn))).toEqual([
      {
        type: 'error',
        code: 'agent_unavailable',
        message: 'The agent is unavailable.',
        errorType: 'server_error',
        param: null,
      },
      { type: 'done' },
    ]);
  });

  it('marks the synthetic recovery text with the alia_meta the API attaches', async () => {
    const wire = aliaStream();
    wire.synthetic('\n\nI encountered a brief interruption.', {
      synthetic: true,
      retryable: true,
      error: { code: 'all_providers_exhausted', reference: 'chatcmpl-x' },
    });
    wire.stop();
    wire.done();
    const { client } = clientFor(sseResponse(wire.wire()));

    const events = await collect(await client.stream(turn));
    expect(events[0]).toMatchObject({
      type: 'text',
      text: '\n\nI encountered a brief interruption.',
      meta: { synthetic: true, retryable: true },
    });
  });

  it('ignores a usage-only frame rather than failing on its empty choices', async () => {
    const wire = aliaStream();
    wire.text('ok');
    wire.stop();
    wire.usage({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    wire.done();
    const { client } = clientFor(sseResponse(wire.wire()));

    expect((await collect(await client.stream(turn))).map((event) => event.type)).toEqual([
      'text',
      'finish',
      'done',
    ]);
  });

  it('fails a stream that ends without [DONE], after yielding what it did read', async () => {
    const wire = aliaStream();
    wire.text('partial');
    const { client } = clientFor(sseResponse(wire.wire()));

    const stream = await client.stream(turn);
    const seen: AliaStreamEvent[] = [];
    const error = await (async () => {
      try {
        for await (const event of stream) seen.push(event);
        return null;
      } catch (reason: unknown) {
        return reason;
      }
    })();

    expect(seen).toEqual([{ type: 'text', text: 'partial' }]);
    expect(error).toBeInstanceOf(AliaStreamError);
    expect(error).toMatchObject({ failure: 'truncated' });
  });

  it('names the shape of a chunk it cannot read, and never its content', async () => {
    const secret = 'the person asked about 12 Privet Drive';
    const { client } = clientFor(
      sseResponse(`data: ${JSON.stringify({ id: 'x', prompt: secret, choices: 'nope' })}\n\ndata: [DONE]\n\n`),
    );

    const error = (await collect(await client.stream(turn)).catch((reason: unknown) => reason)) as AliaStreamError;
    expect(error).toBeInstanceOf(AliaStreamError);
    expect(error.failure).toBe('unexpected_chunk');
    expect(error.shape).toEqual({ keys: ['id', 'prompt', 'choices'], choices: 'string' });
    expect(JSON.stringify(error.shape)).not.toContain('Privet');
  });

  it('fails on a data frame that is not JSON', async () => {
    const { client } = clientFor(sseResponse('data: not json at all\n\ndata: [DONE]\n\n'));
    await expect(collect(await client.stream(turn))).rejects.toMatchObject({
      name: 'AliaStreamError',
      failure: 'malformed_json',
    });
  });

  it('reads comment frames, CRLF endings and a body that never sends its last blank line', async () => {
    const wire = aliaStream();
    wire.text('ok');
    wire.done();
    const crlf = `: keep-alive\r\n\r\n${wire.wire().replace(/\n/g, '\r\n').trimEnd()}`;
    const { client } = clientFor(sseResponse(crlf));

    expect(await collect(await client.stream(turn))).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'done' },
    ]);
  });

  it('stops at [DONE] and does not read what follows it', async () => {
    const wire = aliaStream();
    wire.text('visible');
    wire.done();
    const trailing = `${wire.wire()}data: {"this":"would fail to parse as a chunk"}\n\n`;
    const { client } = clientFor(sseResponse(trailing));

    expect(await collect(await client.stream(turn))).toEqual([
      { type: 'text', text: 'visible' },
      { type: 'done' },
    ]);
  });
});

describe('AliaServerClient — aborting', () => {
  it('stops an in-flight stream and reports an AbortError', async () => {
    const controller = new AbortController();
    const wire = aliaStream();
    wire.text('one');
    wire.text('two');
    wire.done();

    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode(wire.wire().split('\n\n')[0] + '\n\n'));
        // Nothing more is ever enqueued: the turn is still open when the caller
        // gives up, which is the case an abort exists for.
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const { client } = clientFor(response);

    const stream = await client.stream(turn, { signal: controller.signal });
    const seen: AliaStreamEvent[] = [];
    const error = await (async () => {
      try {
        for await (const event of stream) {
          seen.push(event);
          controller.abort();
        }
        return null;
      } catch (reason: unknown) {
        return reason;
      }
    })();

    expect(seen).toEqual([{ type: 'text', text: 'one' }]);
    expect((error as Error).name).toBe('AbortError');
    expect(cancelled).toBe(true);
  });

  it('cancels the body when the consumer stops iterating early', async () => {
    let cancelled = false;
    const wire = aliaStream();
    wire.text('one');
    wire.text('two');
    wire.done();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode(wire.wire()));
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const event of readAliaEventStream(body)) {
      if (event.type === 'text') break;
    }
    expect(cancelled).toBe(true);
  });
});
