import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The list the sidebar reads, and whether a write reaches it.
 *
 * These are not assertions about invalidation calls — they are the owner's
 * symptom itself: make an agent, and it is THERE without a reload. The list is
 * read through `useMyAgents` exactly as the sidebar reads it, the write goes
 * through the mutation exactly as the screen sends it, and what is checked is
 * what the reader ends up holding.
 *
 * That shape matters because the bug was never a missing call. There were two
 * caches of one list — a Zustand store keeping `agents` by hand beside a
 * TanStack query reading the same endpoint — and writing through one could not
 * tell the other. A test that only counted `invalidateQueries` would have gone
 * green against that.
 */

const server = vi.hoisted(() => ({
  /** Every agent the API would answer `GET /agents/me` with, in order. */
  mine: [] as { _id: string; name: string }[],
  /** How many times the list was actually asked for. */
  listCalls: 0,
}));

vi.mock('@/lib/api/client', () => ({
  default: {
    get: vi.fn(async (url: string) => {
      if (url.includes('/agents/me')) {
        server.listCalls += 1;
        return { data: { agents: server.mine } };
      }
      return { data: { agents: [], total: 0 } };
    }),
    post: vi.fn(async (_url: string, body: { name?: string }) => {
      const agent = { _id: 'made', name: body.name ?? 'Made' };
      server.mine = [agent, ...server.mine];
      return { data: { agent } };
    }),
    patch: vi.fn(async (url: string, body: { name?: string }) => {
      const id = url.split('/').pop() ?? '';
      server.mine = server.mine.map((agent) =>
        agent._id === id ? { ...agent, name: body.name ?? agent.name } : agent,
      );
      return { data: { agent: server.mine.find((agent) => agent._id === id) } };
    }),
    delete: vi.fn(async (url: string) => {
      const id = url.split('/').pop() ?? '';
      server.mine = server.mine.filter((agent) => agent._id !== id);
      return { data: {} };
    }),
  },
}));

vi.mock('@oxyhq/services', () => ({ useOxy: () => ({ isAuthenticated: true }) }));

import { useCreateAgent, useDeleteAgent, useUpdateAgent } from '../use-agents';
import { useMyAgents } from '../use-my-agents';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

/**
 * Let the query settle.
 *
 * A fetch and the refetch an invalidation provokes are both asynchronous, so
 * asserting straight after an action reads the list as it was a tick ago —
 * which is exactly the stale answer these tests exist to catch, arriving for
 * the wrong reason.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

type Harness = {
  names: () => string[];
  create: ReturnType<typeof useCreateAgent>;
  update: ReturnType<typeof useUpdateAgent>;
  remove: ReturnType<typeof useDeleteAgent>;
};

async function mount(): Promise<Harness> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let latest: Omit<Harness, 'names'> & { list: { name: string }[] } | undefined;

  function Probe() {
    const mine = useMyAgents();
    latest = {
      list: (mine.data ?? []) as { name: string }[],
      create: useCreateAgent(),
      update: useUpdateAgent(),
      remove: useDeleteAgent(),
    };
    return null;
  }

  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  if (latest === undefined) throw new Error('the probe did not run');
  await settle();

  return {
    names: () => (latest?.list ?? []).map((agent) => agent.name),
    get create() {
      if (latest === undefined) throw new Error('no render');
      return latest.create;
    },
    get update() {
      if (latest === undefined) throw new Error('no render');
      return latest.update;
    },
    get remove() {
      if (latest === undefined) throw new Error('no render');
      return latest.remove;
    },
  };
}

beforeEach(() => {
  server.mine = [];
  server.listCalls = 0;
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

describe('the sidebar’s list, after a write', () => {
  it('shows an agent that has just been created, without a reload', async () => {
    server.mine = [{ _id: 'old', name: 'Already there' }];
    const harness = await mount();
    expect(harness.names()).toEqual(['Already there']);

    await act(async () => {
      await harness.create.mutateAsync({ name: 'Brand new' } as never);
    });
    await settle();

    // The owner's symptom, in one line: nothing remounted, and it is there.
    expect(harness.names()).toEqual(['Brand new', 'Already there']);
  });

  it('drops one that has just been deleted', async () => {
    server.mine = [{ _id: 'keep', name: 'Keep' }, { _id: 'drop', name: 'Drop' }];
    const harness = await mount();
    expect(harness.names()).toEqual(['Keep', 'Drop']);

    await act(async () => {
      await harness.remove.mutateAsync('drop');
    });
    await settle();

    expect(harness.names()).toEqual(['Keep']);
  });

  it('shows the new name after a rename', async () => {
    server.mine = [{ _id: 'a1', name: 'Old name' }];
    const harness = await mount();

    await act(async () => {
      await harness.update.mutateAsync({ id: 'a1', updates: { name: 'New name' } as never });
    });
    await settle();

    expect(harness.names()).toEqual(['New name']);
  });

  it('asks the server again rather than patching a copy by hand', async () => {
    // The property that makes the three above true, and the one the store could
    // not have: there is no second list to edit, so the only way the reader
    // changes is by re-reading.
    server.mine = [{ _id: 'a1', name: 'One' }];
    const harness = await mount();
    const before = server.listCalls;

    await act(async () => {
      await harness.create.mutateAsync({ name: 'Two' } as never);
    });
    await settle();

    expect(server.listCalls).toBeGreaterThan(before);
  });

  it('leaves the list alone when the write was refused', async () => {
    // A refused save has to reach the screen — the editor's autosave depends on
    // it — and a rejected change must not be treated as an accepted one.
    server.mine = [{ _id: 'a1', name: 'One' }];
    const harness = await mount();
    const { default: apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.patch).mockRejectedValueOnce(new Error('refused'));
    const before = server.listCalls;

    await expect(
      act(async () => {
        await harness.update.mutateAsync({ id: 'a1', updates: { name: 'Nope' } as never });
      }),
    ).rejects.toThrow('refused');
    await settle();

    expect(server.listCalls).toBe(before);
    expect(harness.names()).toEqual(['One']);
  });
});
