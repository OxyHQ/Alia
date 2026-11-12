import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixtures = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), ready: true }));
vi.mock('@/shared/api/client', () => ({ default: { get: fixtures.get, post: fixtures.post } }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({
    user: { id: 'owner' },
    canUsePrivateApi: fixtures.ready,
    isAccountCacheReady: fixtures.ready,
  }),
}));
import { useMyAgents } from '../use-my-agents';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer;
let client: QueryClient;
const agent = (id: string, ownerOxyAccountId = 'owner') => ({
  _id: id,
  ownerOxyAccountId,
  status: 'active',
  scheduleInterval: 60,
});
async function settle() {
  for (let n = 0; n < 12; n++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}
function Probe() {
  useMyAgents();
  return null;
}
async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Probe />
        <Probe />
      </QueryClientProvider>,
    );
  });
  await settle();
}
beforeEach(() => {
  vi.clearAllMocks();
  fixtures.ready = true;
  fixtures.get.mockResolvedValue({ data: { agents: [agent('a')] } });
  fixtures.post.mockResolvedValue({ status: 204 });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  client?.clear();
});
it('recovers from a temporary activation failure without refetching the list', async () => {
  fixtures.post.mockRejectedValueOnce(new Error('API deploying'));
  await mount();
  expect(fixtures.get).toHaveBeenCalledTimes(1);
  expect(fixtures.post).toHaveBeenCalledTimes(2);
  expect(client.getQueryData(['agent-work-authority', 'owner', 'a'])).toBe(true);
});
it('shares a successful activation across sidebar consumers and ignores other owners', async () => {
  fixtures.get.mockResolvedValue({
    data: { agents: [agent('a'), agent('foreign', 'organization')] },
  });
  await mount();
  expect(fixtures.post).toHaveBeenCalledTimes(1);
  expect(fixtures.post).toHaveBeenCalledWith(
    '/agents/a/work',
    {},
    { signal: expect.any(AbortSignal) },
  );
});
it('a permanent denial for one agent does not prevent another from activating', async () => {
  fixtures.get.mockResolvedValue({ data: { agents: [agent('a'), agent('b')] } });
  fixtures.post.mockImplementation(async (url: string) => {
    if (url === '/agents/a/work')
      throw new AxiosError('Forbidden', undefined, undefined, undefined, {
        status: 403,
        statusText: 'Forbidden',
        data: null,
        headers: {},
        config: { headers: new AxiosHeaders() },
      });
    return { status: 204 };
  });
  await mount();
  expect(fixtures.post).toHaveBeenCalledTimes(2);
  expect(client.getQueryData(['agent-work-authority', 'owner', 'b'])).toBe(true);
});
it('does not contact the private API while account restoration is incomplete', async () => {
  fixtures.ready = false;
  await mount();
  expect(fixtures.get).not.toHaveBeenCalled();
  expect(fixtures.post).not.toHaveBeenCalled();
});
