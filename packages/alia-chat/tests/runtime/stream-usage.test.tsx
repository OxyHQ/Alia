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

const stream = vi.hoisted(() => ({
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

vi.mock('@oxy.so/services/ui/client', () => ({
  // The host's app assertion (ADR 0021): none here (`tests/support/app-assertion-host.ts`).
  useAppAssertion: () => ({
    getAppAssertion: async () => null,
    getAppAssertionHeaders: async () => ({}),
  }),
  useOxy: () => ({
    user:
      typeof harness !== 'undefined' && 'user' in harness
        ? (harness as { user: unknown }).user
        : null,
    oxyServices: {
      createLinkedClient: () => ({
        client: {
          requestAuthenticatedResponse: (config: { url: string }) =>
            stream.fetch(config.url, config as never),
        },
        dispose: () => {},
      }),
    },
  }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { AliaRuntimeProvider, type AliaRuntimeHost } from '../../src/runtime/config';
import { useConversationStream } from '../../src/runtime/use-conversation-stream';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** What the host around the stream hears; each suite reads the calls it cares about. */
const onUsage = vi.fn();
const host: AliaRuntimeHost = { onUsage };

let api: ReturnType<typeof useConversationStream>;
let renderer: ReactTestRenderer | null = null;

function Probe() {
  api = useConversationStream({ conversationId: 'c1' });
  return null;
}

let client: QueryClient;
async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <AliaRuntimeProvider apiUrl="http://test.invalid" host={host}>
          <Probe />
        </AliaRuntimeProvider>
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
  onUsage.mockReset();
});

afterEach(async () => {
  if (renderer !== null) {
    await act(async () => renderer?.unmount());
    renderer = null;
  }
});

describe('the usage frame', () => {
  it('reaches the host as the server wrote it, even on a chunk without choices', async () => {
    const warning = {
      level: 'critical',
      daysRemaining: 1.5,
      todaySpend: 90,
      avgDailySpend: 20,
      currentModelMultiplier: 4,
    };
    harness.responses.push([contentFrame('hi'), stopFrame, usageFrame(warning), done]);
    await mount();
    await act(async () => {
      await api.append({ role: 'user', content: 'hello' });
    });

    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
      credits_remaining: 41,
      credit_warning: warning,
    });
  });

  it('reaches the host with no warning when the server sends none', async () => {
    harness.responses.push([contentFrame('hi'), stopFrame, usageFrame(null), done]);
    await mount();
    await act(async () => {
      await api.append({ role: 'user', content: 'hello' });
    });
    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
      credits_remaining: 41,
      credit_warning: null,
    });
  });
});
