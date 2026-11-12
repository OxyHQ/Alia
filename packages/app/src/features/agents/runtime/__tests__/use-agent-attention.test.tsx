import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What an agent notices on its own (ADR 0026): the requests the hooks send and what they refresh.
 * The API client is doubled; the hooks, their keys and their invalidation are real.
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));

vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ isAuthenticated: true, canUsePrivateApi: true, isAccountCacheReady: true }),
}));
vi.mock('@/shared/api/client', () => ({
  default: { get: api.get, post: api.post, delete: api.delete, patch: vi.fn(), put: vi.fn() },
}));

const { useAgentInbox, useAgentSubscriptionMutations, useAgentSubscriptions } = await import(
  '../use-agent-attention'
);

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;
let client: QueryClient;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function useHarness() {
  return {
    subscriptions: useAgentSubscriptions('agent-1'),
    inbox: useAgentInbox('agent-1'),
    ...useAgentSubscriptionMutations('agent-1'),
  };
}

async function mount() {
  const seen: { current: ReturnType<typeof useHarness> | null } = { current: null };
  function Probe() {
    seen.current = useHarness();
    return null;
  }
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await settle();
  return seen as { current: ReturnType<typeof useHarness> };
}

const subscription = {
  id: 's1',
  agentId: 'agent-1',
  ownerAccountId: 'owner',
  sourceAccountId: 'owner',
  appId: 'inbox',
  eventType: 'new_email',
  enabled: true,
};

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get
    .mockReset()
    .mockImplementation(async (url: string) =>
      url.endsWith('/inbox')
        ? { data: { items: [{ id: 'i1', summary: { subject: 'Hi' } }] } }
        : { data: { subscriptions: [subscription] } },
    );
  api.post.mockReset().mockResolvedValue({ data: { subscription } });
  api.delete.mockReset().mockResolvedValue({ data: undefined });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('agent attention hooks', () => {
  it('reads the subscriptions and the pending inbox', async () => {
    const seen = await mount();
    expect(api.get).toHaveBeenCalledWith('/agents/agent-1/subscriptions');
    expect(api.get).toHaveBeenCalledWith('/agents/agent-1/inbox', {
      params: { status: 'pending' },
    });
    expect(seen.current.subscriptions.data).toEqual([subscription]);
    expect(seen.current.inbox.data?.items).toHaveLength(1);
    // The route said nothing about the heartbeat: it reads as none, never as an error.
    expect(seen.current.inbox.data?.heartbeat).toEqual({
      intervalMinutes: null,
      lastHeartbeatAt: null,
    });
  });

  it('subscribes with the strict body and refetches the subscriptions', async () => {
    const seen = await mount();
    const before = api.get.mock.calls.length;
    await act(async () => {
      await seen.current.subscribe.mutateAsync({
        appId: 'inbox',
        eventType: 'new_email',
        account: 'agent',
      });
    });
    await settle();
    expect(api.post).toHaveBeenCalledWith('/agents/agent-1/subscriptions', {
      appId: 'inbox',
      eventType: 'new_email',
      account: 'agent',
    });
    expect(api.get.mock.calls.length).toBeGreaterThan(before);
  });

  it('unsubscribes by id and refetches', async () => {
    const seen = await mount();
    const before = api.get.mock.calls.length;
    await act(async () => {
      await seen.current.unsubscribe.mutateAsync('s1');
    });
    await settle();
    expect(api.delete).toHaveBeenCalledWith('/agents/agent-1/subscriptions/s1');
    expect(api.get.mock.calls.length).toBeGreaterThan(before);
  });

  it('rejects on the 25-subscription limit (409) so the screen can say why', async () => {
    api.post.mockRejectedValue({ response: { status: 409, data: { error: 'limit' } } });
    const seen = await mount();
    await expect(
      act(async () => {
        await seen.current.subscribe.mutateAsync({
          appId: 'inbox',
          eventType: 'new_email',
          account: 'owner',
        });
      }),
    ).rejects.toMatchObject({ response: { status: 409 } });
  });
});
