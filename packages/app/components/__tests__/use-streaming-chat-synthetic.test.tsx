import React from 'react';
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
    return { ok: true, status: 200, body };
  },
}));

vi.mock('expo-haptics', () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: 'light' },
}));
vi.mock('@oxy.so/services', () => ({
  useOxy: () => ({ oxyServices: { getAccessToken: () => 'token' } }),
}));
vi.mock('@/lib/device-info', () => ({ collectDeviceInfo: async () => ({}) }));
vi.mock('@/lib/hooks/use-agent-row-preview', () => ({ useAgentRowPreview: () => () => {} }));
vi.mock('@/lib/hooks/use-user-data', () => ({ USER_MEMORY_QUERY_KEY: ['memory'] }));
vi.mock('@/lib/stores/model-store', () => ({
  useModelStore: { getState: () => ({ webSearch: true, setSelectedModel: () => {} }) },
}));
vi.mock('@/lib/stores/ui-store', () => ({
  useUIStore: { getState: () => ({ addCanvasArtifact: () => {}, setRightPanel: () => {}, openAgentPanel: () => {} }) },
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/i18n', () => ({ default: { t: (k: string) => k } }));

import { useStreamingChat } from '@/lib/hooks/use-streaming-chat';

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
    expect(harness.requests[1].messages).toEqual([{ role: 'user', content: 'hello?' }]);
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

  it('takes the failure down the moment a new message is sent', async () => {
    harness.responses.push(synthetic(), [contentFrame('Sure.'), stopFrame, done]);
    await mount();
    await act(async () => { await api.append({ role: 'user', content: 'first' }); });
    expect(api.failedTurn).not.toBeNull();

    await act(async () => { await api.append({ role: 'user', content: 'second' }); });

    expect(api.failedTurn).toBeNull();
  });
});
