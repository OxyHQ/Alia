import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The turn's usage frame, as the server writes it: its own chunk, with
 * `choices: []` and the numbers under `alia_usage`.
 *
 * The hook read usage AFTER skipping every chunk without a choice, so this
 * frame never reached it — the balance was not updated from it and the
 * spending warning the server computes for the person (`credit_warning`) was
 * dropped, which is half of why the low-credit warning had gone silent.
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

let client: QueryClient;
async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
}

const contentFrame = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
const stopFrame = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
const usageFrame = (creditWarning: unknown) =>
  `data: ${JSON.stringify({
    object: 'chat.completion.chunk',
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    alia_usage: { credits_charged: 3, credits_remaining: 41, credit_warning: creditWarning },
  })}\n\n`;
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

describe('the usage frame', () => {
  it('updates the balance and keeps the server’s spending warning', async () => {
    harness.responses.push([
      contentFrame('hi'),
      stopFrame,
      usageFrame({ level: 'critical', daysRemaining: 1.5, todaySpend: 90, avgDailySpend: 20, currentModelMultiplier: 4 }),
      done,
    ]);
    await mount();
    client.setQueryData(['credits'], { credits: 44 });
    await act(async () => { await api.append({ role: 'user', content: 'hello' }); });

    expect(client.getQueryData<{ credits: number }>(['credits'])?.credits).toBe(41);
    expect(client.getQueryData(['usage-warning'])).toEqual({
      level: 'critical',
      daysRemaining: 1.5,
      todaySpend: 90,
      avgDailySpend: 20,
      currentModelMultiplier: 4,
    });
  });

  it('keeps no warning when the server sends none', async () => {
    harness.responses.push([contentFrame('hi'), stopFrame, usageFrame(null), done]);
    await mount();
    await act(async () => { await api.append({ role: 'user', content: 'hello' }); });
    expect(client.getQueryData(['usage-warning'])).toBeUndefined();
  });
});
