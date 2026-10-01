import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the streaming hook does with a reply the server made up.
 *
 * An exhausted upstream is answered with HTTP 200 and a content delta flagged
 * `alia_meta: { synthetic: true, retryable: true }`. The hook used to roll the
 * turn back and leave the screen to show a toast, so once the toast was gone
 * nothing on screen said what happened. Pinned here, against a real SSE body
 * read through the hook's own frame reader:
 *
 *  - the person's turn STAYS, with a failure attached to it and no assistant
 *    row pretending an answer is coming;
 *  - the synthetic text is never appended as Alia's words;
 *  - a retry re-sends the same content through the same path, onto a history
 *    that holds the message once;
 *  - real output followed by a synthetic tail keeps the output and marks the
 *    tail as an error, anchored on the answer.
 */

const harness = vi.hoisted(() => ({
  /** Each request's body, decoded, in order. */
  requests: [] as { messages: { role: string; content: unknown }[] }[],
  /** The SSE bodies to answer with, consumed in order. */
  responses: [] as string[][],
  /** The HTTP status of each response, in order; 200 when none is queued. */
  statuses: [] as number[],
}));

vi.mock('expo/fetch', () => ({
  fetch: async (_url: string, init: { body: string }) => {
    harness.requests.push(JSON.parse(init.body));
    const frames = harness.responses.shift();
    if (frames === undefined) throw new Error('no response queued');
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    const status = harness.statuses.shift() ?? 200;
    return { ok: status >= 200 && status < 300, status, statusText: '', body };
  },
}));

vi.mock('expo-haptics', () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: 'light' },
}));
vi.mock('@oxy.so/services', () => ({
  useOxy: () => ({ oxyServices: { session: { accessToken: 'token' } } }),
}));
vi.mock('@/shared/platform/device-info', () => ({ collectDeviceInfo: async () => ({}) }));
vi.mock('@/features/chat/runtime/use-agent-row-preview', () => ({ useAgentRowPreview: () => () => {} }));
vi.mock('@/features/memory/runtime/use-user-data', () => ({ USER_MEMORY_QUERY_KEY: ['memory'] }));
vi.mock('@/features/chat/runtime/model-store', () => ({
  useModelStore: { getState: () => ({ webSearch: true, setSelectedModel: () => {} }) },
}));
vi.mock('@/features/chat/runtime/ui-store', () => ({
  useUIStore: { getState: () => ({ addCanvasArtifact: () => {}, setRightPanel: () => {}, openAgentPanel: () => {} }) },
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/shared/i18n', () => ({ default: { t: (k: string) => k } }));

import { useStreamingChat } from '@/features/chat/runtime/use-streaming-chat';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let api: ReturnType<typeof useStreamingChat>;
let renderer: ReactTestRenderer | null = null;

function Probe() {
  api = useStreamingChat('http://test.invalid/chat', 'c1');
  return null;
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
}

/** One OpenAI-shaped content chunk, optionally wearing the server's stand-in flag. */
const contentFrame = (content: string, meta?: { synthetic: boolean; retryable: boolean }) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }], ...(meta ? { alia_meta: meta } : {}) })}\n\n`;
const stopFrame = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
const done = 'data: [DONE]\n\n';

/** The server's whole answer when every provider is exhausted, as it writes it. */
const BUSY = "I'm sorry, all models are currently busy. Please try again in a few seconds.";
const synthetic = (retryable = true) => [contentFrame(BUSY, { synthetic: true, retryable }), stopFrame, done];

beforeEach(() => {
  harness.requests.length = 0;
  harness.responses.length = 0;
  harness.statuses.length = 0;
});

afterEach(async () => {
  if (renderer !== null) {
    await act(async () => renderer?.unmount());
    renderer = null;
  }
});

describe('a synthetic reply', () => {
  it('keeps the person’s turn in the thread, with a failure on it and no answer row', async () => {
    harness.responses.push(synthetic());
    await mount();

    let outcome: string | undefined;
    await act(async () => { outcome = await api.append({ role: 'user', content: 'hello?' }); });

    expect(outcome).toBe('errored');
    // The turn is still there — and ONLY the turn: no empty assistant bubble.
    expect(api.messages.map((m) => [m.role, m.content])).toEqual([['user', 'hello?']]);
    expect(api.failedTurn).toMatchObject({
      userMessageId: api.messages[0].id,
      anchorMessageId: api.messages[0].id,
      retryable: true,
      partial: false,
    });
    expect(api.isLoading).toBe(false);
  });

  it('never renders the stand-in text as Alia’s words', async () => {
    harness.responses.push(synthetic());
    await mount();
    await act(async () => { await api.append({ role: 'user', content: 'hello?' }); });

    expect(JSON.stringify(api.messages)).not.toContain('all models are currently busy');
  });

  it('offers no retry when the server says the turn is not retryable', async () => {
    harness.responses.push(synthetic(false));
    await mount();
    await act(async () => { await api.append({ role: 'user', content: 'hello?' }); });

    expect(api.failedTurn?.retryable).toBe(false);
  });

  it('re-sends the same turn on retry, onto a history that holds it once', async () => {
    harness.responses.push(synthetic(), [contentFrame('Hello!'), stopFrame, done]);
    await mount();
    await act(async () => { await api.append({ role: 'user', content: 'hello?' }); });

    let outcome: string | undefined;
    await act(async () => { outcome = await api.retryFailedTurn(); });

    expect(outcome).toBe('sent');
    // Two requests, and the second carries the message exactly once — the
    // failed turn was cut out of the history before it was re-sent, so the
    // server neither sees it twice nor stores it twice.
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1].messages).toEqual([{ id: expect.any(String), role: 'user', content: 'hello?' }]);
    expect(api.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello?'],
      ['assistant', 'Hello!'],
    ]);
    expect(api.failedTurn).toBeNull();
  });

  it('keeps real output that came before a synthetic tail, and marks the tail as an error', async () => {
    harness.responses.push([
      contentFrame('Here is the first half'),
      contentFrame('\n\nI encountered a brief interruption. Please send your message again.', { synthetic: true, retryable: true }),
      stopFrame,
      done,
    ]);
    await mount();

    let outcome: string | undefined;
    await act(async () => { outcome = await api.append({ role: 'user', content: 'tell me' }); });

    // The output is theirs to keep, so this is a sent turn…
    expect(outcome).toBe('sent');
    expect(api.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'tell me'],
      ['assistant', 'Here is the first half'],
    ]);
    // …with the failure anchored on the ANSWER, as its tail, not on the question.
    expect(api.failedTurn).toMatchObject({
      userMessageId: api.messages[0].id,
      anchorMessageId: api.messages[1].id,
      partial: true,
      retryable: true,
    });
  });

  it('keeps output that came before an in-stream error frame, and shows code and reference, not the server prose', async () => {
    // What the server writes when a step fails after text and a tool call:
    // the `{"error": …}` frame and [DONE], with no stop chunk.
    const errorFrame = `data: ${JSON.stringify({ error: {
      message: 'Service temporarily unavailable. Please try again in a moment.',
      type: 'server_error',
      param: null,
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      reference: 'chatcmpl-ref-1',
    } })}\n\n`;
    harness.responses.push(
      [contentFrame('Voy a abrir Mention y mirar las tendencias.'), errorFrame, done],
      [contentFrame('Estas son las tendencias.'), stopFrame, done],
    );
    await mount();

    let outcome: string | undefined;
    await act(async () => { outcome = await api.append({ role: 'user', content: 'Que tendencias hay en Mention?' }); });

    expect(outcome).toBe('sent');
    expect(api.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Que tendencias hay en Mention?'],
      ['assistant', 'Voy a abrir Mention y mirar las tendencias.'],
    ]);
    expect(api.messages[1].turnOutcome).toBe('failed');
    expect(api.failedTurn).toMatchObject({
      anchorMessageId: api.messages[1].id,
      partial: true,
      retryable: true,
      detail: 'PROVIDER_UNAVAILABLE · Ref chatcmpl-ref-1',
    });

    // Retry re-sends the question once, without the half answer.
    await act(async () => { await api.retryFailedTurn(); });
    expect(harness.requests[1].messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(harness.requests[1].messages.some((m) => m.role === 'assistant')).toBe(false);
    expect(api.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Que tendencias hay en Mention?'],
      ['assistant', 'Estas son las tendencias.'],
    ]);
    expect(api.failedTurn).toBeNull();
  });

  /** Alia's envelope for a turn that failed before any output. */
  const preOutputFailure = (retryable = true) => ({ error: {
    message: 'Service temporarily unavailable. Please try again in a moment.',
    type: 'server_error',
    param: null,
    code: 'PROVIDER_UNAVAILABLE',
    retryable,
    reference: 'chatcmpl-ref-0',
  } });

  it('draws a failure before any output, sent as an error frame, as a failed turn with Retry', async () => {
    harness.responses.push(
      [': keep-alive\n\n', `data: ${JSON.stringify(preOutputFailure())}\n\n`, done],
      [contentFrame('Hola.'), stopFrame, done],
    );
    await mount();

    let outcome: string | undefined;
    await act(async () => { outcome = await api.append({ role: 'user', content: 'hola' }); });

    expect(outcome).toBe('errored');
    // No answer row, nothing of the server's prose: the person's turn, with the card.
    expect(api.messages.map((m) => [m.role, m.content])).toEqual([['user', 'hola']]);
    expect(api.failedTurn).toMatchObject({
      anchorMessageId: api.messages[0].id,
      partial: false,
      retryable: true,
      detail: 'PROVIDER_UNAVAILABLE · Ref chatcmpl-ref-0',
    });

    await act(async () => { await api.retryFailedTurn(); });
    expect(harness.requests[1].messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(api.messages.map((m) => [m.role, m.content])).toEqual([['user', 'hola'], ['assistant', 'Hola.']]);
    expect(api.failedTurn).toBeNull();
  });

  it('draws the same card for a failure answered with an HTTP 503 before the stream opened', async () => {
    harness.statuses.push(503);
    harness.responses.push([JSON.stringify(preOutputFailure())]);
    await mount();

    let outcome: string | undefined;
    await act(async () => { outcome = await api.append({ role: 'user', content: 'hola' }); });

    expect(outcome).toBe('errored');
    expect(api.messages.map((m) => m.role)).toEqual(['user']);
    expect(api.failedTurn).toMatchObject({
      partial: false,
      retryable: true,
      detail: 'PROVIDER_UNAVAILABLE · Ref chatcmpl-ref-0',
    });
  });

  it('offers no retry for a failure before output the server says retrying cannot fix', async () => {
    harness.statuses.push(500);
    harness.responses.push([JSON.stringify(preOutputFailure(false))]);
    await mount();

    await act(async () => { await api.append({ role: 'user', content: 'hola' }); });
    expect(api.failedTurn).toMatchObject({ retryable: false, partial: false });
  });

  it('takes the failure down the moment a new message is sent', async () => {
    harness.responses.push(synthetic(), [contentFrame('Sure.'), stopFrame, done]);
    await mount();
    await act(async () => { await api.append({ role: 'user', content: 'first' }); });
    expect(api.failedTurn).not.toBeNull();

    await act(async () => { await api.append({ role: 'user', content: 'second' }); });

    expect(api.failedTurn).toBeNull();
  });
});
