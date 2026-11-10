import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Spaces (ADR 0028): the requests the hooks send and what they refresh. The API client is doubled;
 * the hooks, their keys and their invalidation are real.
 */

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({ isAuthenticated: true }) }));
vi.mock('@/shared/api/client', () => ({ default: api }));

const { spaceErrorCode, useSpaceMutations, useSpaces } = await import('../use-spaces');

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
  return { spaces: useSpaces(), ...useSpaceMutations() };
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

const space = {
  id: 's1',
  name: 'Equipo',
  instructions: '',
  conversationId: 'room1',
  memberAgentIds: ['a1'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

let invalidated: unknown[][];

/** The three lists a change to a space must read again: spaces, the person's agents, conversations. */
const REFRESHED = [['spaces'], ['agents', 'mine'], ['conversations']];

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidated = [];
  const original = client.invalidateQueries.bind(client);
  vi.spyOn(client, 'invalidateQueries').mockImplementation((filters) => {
    invalidated.push([...((filters?.queryKey as unknown[]) ?? [])]);
    return original(filters);
  });
  api.get.mockReset().mockResolvedValue({ data: { spaces: [space] } });
  api.post.mockReset().mockResolvedValue({ data: { space } });
  api.patch.mockReset().mockResolvedValue({ data: { space } });
  api.put.mockReset().mockResolvedValue({ data: { space } });
  api.delete.mockReset().mockResolvedValue({ data: undefined });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe('space hooks', () => {
  it('reads the person’s spaces', async () => {
    const seen = await mount();
    expect(api.get).toHaveBeenCalledWith('/spaces');
    expect(seen.current.spaces.data).toEqual([space]);
  });

  it('creates with the strict body it was given and refreshes spaces, agents and conversations', async () => {
    const seen = await mount();
    await act(async () => {
      await seen.current.createSpace.mutateAsync({
        name: 'Equipo',
        instructions: 'Lanzar la beta',
        agentIds: ['a1', 'a2'],
      });
    });
    expect(api.post).toHaveBeenCalledWith('/spaces', {
      name: 'Equipo',
      instructions: 'Lanzar la beta',
      agentIds: ['a1', 'a2'],
    });
    expect(invalidated).toEqual(REFRESHED);
  });

  it('renames and rewrites the brief with PATCH, the id only in the path', async () => {
    const seen = await mount();
    await act(async () => {
      await seen.current.updateSpace.mutateAsync({ id: 's1', name: 'Nuevo' });
    });
    expect(api.patch).toHaveBeenCalledWith('/spaces/s1', { name: 'Nuevo' });
    await act(async () => {
      await seen.current.updateSpace.mutateAsync({ id: 's1', instructions: '' });
    });
    expect(api.patch).toHaveBeenLastCalledWith('/spaces/s1', { instructions: '' });
    expect(invalidated).toEqual([...REFRESHED, ...REFRESHED]);
  });

  it('moves an agent with PUT on the member path and takes it out with DELETE', async () => {
    const seen = await mount();
    await act(async () => {
      await seen.current.moveAgent.mutateAsync({ spaceId: 's2', agentId: 'a1' });
    });
    expect(api.put).toHaveBeenCalledWith('/spaces/s2/members/a1');
    expect(invalidated).toEqual(REFRESHED);
    invalidated.length = 0;
    await act(async () => {
      await seen.current.removeAgent.mutateAsync({ spaceId: 's2', agentId: 'a1' });
    });
    expect(api.delete).toHaveBeenCalledWith('/spaces/s2/members/a1');
    expect(invalidated).toEqual(REFRESHED);
  });

  it('deletes a space by id and refreshes', async () => {
    const seen = await mount();
    await act(async () => {
      await seen.current.deleteSpace.mutateAsync('s1');
    });
    expect(api.delete).toHaveBeenCalledWith('/spaces/s1');
    expect(invalidated).toEqual(REFRESHED);
  });

  it('rejects on a refusal and refreshes nothing, so the caller can say why (409 space_full)', async () => {
    const refusal = { response: { status: 409, data: { error: 'full', code: 'space_full' } } };
    api.put.mockRejectedValue(refusal);
    const seen = await mount();
    await expect(
      act(async () => {
        await seen.current.moveAgent.mutateAsync({ spaceId: 's1', agentId: 'a9' });
      }),
    ).rejects.toBe(refusal);
    expect(invalidated).toEqual([]);
    expect(spaceErrorCode(refusal)).toBe('space_full');
  });
});

describe('spaceErrorCode', () => {
  it('names the two 409s the sidebar acts on, and nothing else', () => {
    const at = (status: number, code?: string) => ({ response: { status, data: { code } } });
    expect(spaceErrorCode(at(409, 'space_full'))).toBe('space_full');
    expect(spaceErrorCode(at(409, 'agent_in_other_space'))).toBe('agent_in_other_space');
    expect(spaceErrorCode(at(409, 'something_else'))).toBeUndefined();
    expect(spaceErrorCode(at(404, 'space_full'))).toBeUndefined();
    expect(spaceErrorCode(new Error('boom'))).toBeUndefined();
  });
});
