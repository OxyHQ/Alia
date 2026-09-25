import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One identity per message, from the send to the server and back.
 *
 * The server stores a turn under the ids the client drew it with
 * (`packages/api/src/lib/conversation-saver.ts`): the question and the history
 * by their `id`, the reply by the request's `assistantMessageId`, and a
 * delegated agent's answers by a name derived from the reply's. A vote or a
 * read-aloud addresses a message by `Message.id`, so these have to be the ids
 * on screen — before this, the server wrote `msg-<seq>` and every reply of the
 * session answered 404 until a reload.
 *
 * And `unsaved` says when the server holds them: from the send until the turn
 * completes, and for good on a turn that failed.
 */

const harness = vi.hoisted(() => ({
  requests: [] as {
    messages: { id?: string; role: string; content: unknown }[];
    assistantMessageId?: string;
  }[],
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

vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, ImpactFeedbackStyle: { Light: 'light' } }));
vi.mock('@oxy.so/services', () => ({ useOxy: () => ({ oxyServices: { getAccessToken: () => 'token' } }) }));
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

const contentFrame = (content: string, meta?: { synthetic: boolean; retryable: boolean }) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }], ...(meta ? { alia_meta: meta } : {}) })}\n\n`;
const agentFrame = (agentId: string, content: string) =>
  `event: alia.agent\ndata: ${JSON.stringify({ eventVersion: 1, agentId, agentName: agentId, agentHandle: agentId, agentColor: null, content })}\n\n`;
const stopFrame = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
const done = 'data: [DONE]\n\n';

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

describe('the ids a turn is sent and stored under', () => {
  it('sends every message under its on-screen id, and names the reply it is drawing', async () => {
    harness.responses.push(
      [contentFrame('first answer'), stopFrame, done],
      [agentFrame('scout', 'from scout'), agentFrame('sage', 'from sage'), contentFrame('second answer'), stopFrame, done],
    );
    await mount();
    await act(async () => { await api.append({ role: 'user', content: 'one' }); });
    await act(async () => { await api.append({ role: 'user', content: 'two' }); });

    const [question1, reply1, question2, scout, sage, reply2] = api.messages;
    expect(api.messages.map((m) => m.content)).toEqual(['one', 'first answer', 'two', 'from scout', 'from sage', 'second answer']);

    expect(harness.requests[0]).toMatchObject({
      messages: [{ id: question1.id, role: 'user', content: 'one' }],
      assistantMessageId: reply1.id,
    });
    expect(harness.requests[1]).toMatchObject({
      messages: [
        { id: question1.id, content: 'one' },
        { id: reply1.id, content: 'first answer' },
        { id: question2.id, content: 'two' },
      ],
      assistantMessageId: reply2.id,
    });
    // The server derives the same names for the agents' answers.
    expect([scout.id, sage.id]).toEqual([`${reply2.id}-agent-0`, `${reply2.id}-agent-1`]);
    expect(new Set(api.messages.map((m) => m.id)).size).toBe(6);
  });

  it('holds the turn unsaved until it completes, and then the server has it', async () => {
    harness.responses.push([agentFrame('scout', 'from scout'), contentFrame('answer'), stopFrame, done]);
    await mount();
    await act(async () => { await api.append({ role: 'user', content: 'hi' }); });

    expect(api.messages.map((m) => [m.content, m.unsaved])).toEqual([
      ['hi', undefined],
      ['from scout', undefined],
      ['answer', undefined],
    ]);
  });

  it('leaves a failed turn unsaved, because the server never stored it', async () => {
    harness.responses.push([
      contentFrame('the first half'),
      contentFrame('busy', { synthetic: true, retryable: true }),
      stopFrame,
      done,
    ]);
    await mount();
    await act(async () => { await api.append({ role: 'user', content: 'hi' }); });

    expect(api.messages.map((m) => [m.content, m.turnOutcome, m.unsaved])).toEqual([
      ['hi', undefined, true],
      ['the first half', 'failed', true],
    ]);
  });
});
