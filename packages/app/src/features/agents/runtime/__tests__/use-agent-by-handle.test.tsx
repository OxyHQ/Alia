import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** `/@handle/details` and `/@handle/edit` read the agent by its handle, into the cache `useAgent` reads. */

const { get, oxy } = vi.hoisted(() => ({
  get: vi.fn(),
  oxy: { isPrivateApiPending: false },
}));
vi.mock('@alia.onl/sdk/runtime', () => ({
  aliaQueryKeys: { agents: { profile: () => ['profile'] } },
}));
vi.mock('@/shared/api/client', () => ({ default: { get } }));
vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => oxy }));

const { useAgentByHandle } = await import('@/features/agents/runtime/use-agents');
const { queryKeys } = await import('@/shared/api/query-keys');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
function mount(handle: string, client: QueryClient) {
  let value!: ReturnType<typeof useAgentByHandle>;
  const Probe = () => {
    value = useAgentByHandle(handle);
    return null;
  };
  const wrapper = (children: React.ReactNode) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  act(() => {
    renderer = create(wrapper(<Probe />));
  });
  return () => value;
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  get.mockReset();
});

describe('useAgentByHandle', () => {
  it('asks the API for the handle and puts the card where `useAgent(id)` reads it', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    get.mockResolvedValue({ data: { agent: { _id: 'a1', handle: 'pepe', name: 'Pepe' } } });
    const read = mount('pepe', client);
    await settle();
    expect(get).toHaveBeenCalledWith('/agents/handle/pepe');
    expect(read().data).toMatchObject({ _id: 'a1' });
    expect(client.getQueryData(queryKeys.agents.detail('a1'))).toMatchObject({ handle: 'pepe' });
  });

  it('asks for nothing without a handle', async () => {
    const client = new QueryClient();
    mount('', client);
    await settle();
    expect(get).not.toHaveBeenCalled();
  });

  it('does not retry a 404: it is the answer, the one “not found”', async () => {
    const client = new QueryClient();
    get.mockRejectedValue({ response: { status: 404 }, status: 404 });
    const read = mount('nobody', client);
    await settle();
    await settle();
    expect(get).toHaveBeenCalledTimes(1);
    expect(read().isError).toBe(true);
  });
});
