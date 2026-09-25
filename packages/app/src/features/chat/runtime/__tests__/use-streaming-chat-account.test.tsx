import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #608 §4: the new-chat screen stays mounted across a sign-out or a switch,
 * and in ghost mode its thread lives nowhere else. The next person must not
 * find the previous one's conversation on it.
 */

const harness = vi.hoisted(() => ({ user: { id: 'A' } as { id: string } | null }));

vi.mock('expo/fetch', () => ({
  fetch: async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'A’s answer' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          ),
        );
        controller.close();
      },
    });
    return { ok: true, status: 200, body };
  },
}));
vi.mock('expo-haptics', () => ({ impactAsync: async () => {}, ImpactFeedbackStyle: { Light: 'light' } }));
vi.mock('@oxy.so/services', () => ({
  useOxy: () => ({ oxyServices: { getAccessToken: () => 'token' }, user: harness.user }),
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
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Probe() {
  api = useStreamingChat('http://test.invalid/chat');
  return null;
}
const render = () =>
  act(async () => {
    const tree = (
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    );
    if (renderer) renderer.update(tree);
    else renderer = create(tree);
  });

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

describe('the thread on the new-chat screen', () => {
  it('is emptied when its account signs out', async () => {
    harness.user = { id: 'A' };
    await render();
    await act(async () => { await api.append({ role: 'user', content: 'A’s secret' }); });
    expect(api.messages.length).toBe(2);

    harness.user = null;
    await render();
    expect(api.messages).toEqual([]);
  });

  it('is emptied when the device switches to another account', async () => {
    harness.user = { id: 'A' };
    await render();
    await act(async () => { await api.append({ role: 'user', content: 'A’s secret' }); });
    harness.user = { id: 'B' };
    await render();
    expect(api.messages).toEqual([]);
  });

  it('is kept on a first sign-in from signed out', async () => {
    harness.user = null;
    await render();
    await act(async () => { api.setMessages([{ id: 'g1', role: 'user', content: 'typed as a guest' }]); });
    harness.user = { id: 'A' };
    await render();
    expect(api.messages.length).toBe(1);
  });
});
