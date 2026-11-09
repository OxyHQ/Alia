import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const get = vi.hoisted(() => vi.fn());
const prefetchConversation = vi.hoisted(() => vi.fn());
vi.mock('@/shared/api/client', () => ({ default: { get } }));
vi.mock('@alia.onl/sdk/runtime', () => ({
  usePrefetchConversation: () => prefetchConversation,
}));

const { usePrefetchAgentThread } = await import('../use-agent-thread');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let prefetch!: ReturnType<typeof usePrefetchAgentThread>;
  function Probe() {
    prefetch = usePrefetchAgentThread();
    return null;
  }
  act(() => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  return { client, prefetch: (...args: Parameters<typeof prefetch>) => prefetch(...args) };
}

afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
  get.mockReset();
  prefetchConversation.mockReset();
});

describe('reading an agent’s thread ahead of the press', () => {
  it('never asks for the thread of an agent the person has not talked to: asking CREATES it', async () => {
    const { prefetch } = mount();
    prefetch('pepe', false);
    await act(async () => {});
    expect(get).not.toHaveBeenCalled();
  });

  it('reads the thread and then the conversation behind it, under the key the screen reads', async () => {
    get.mockResolvedValue({ data: { agent: { _id: 'a1' }, conversationId: 'c9' } });
    const { client, prefetch } = mount();
    prefetch('pepe', true);
    await vi.waitFor(() => expect(prefetchConversation).toHaveBeenCalledWith('c9'));
    expect(get).toHaveBeenCalledOnce();
    expect(client.getQueryData(['agent-thread', 'pepe', 'default'])).toMatchObject({
      conversationId: 'c9',
    });
  });
});
