import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * "Continue without an account" grants no authenticated endpoint (#608 §3.2).
 *
 * Every hook here reads something that is the account's — its skills and
 * connectors, its library, its pending approvals, an agent's threads, its
 * teams — and each is reachable signed out: the agent editor and the teams page
 * by link, an agent's page and its approvals from the Agents page. Signed out,
 * none of them may send a request, since each could only answer 401 (and the
 * approvals would do it once a minute). Signed in, each asks as before.
 */

const getRequest = vi.hoisted(() => vi.fn(async () => ({ data: {} })));
const loadFiles = vi.hoisted(() => vi.fn(async () => undefined));
const auth = vi.hoisted(() => ({ isAuthenticated: false }));

vi.mock('@/shared/api/client', () => ({
  default: { get: getRequest, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@oxy.so/services', () => ({ useOxy: () => auth }));
vi.mock('@/features/library/runtime/library-store', () => {
  const state = { files: [], loadFiles };
  return { useLibraryStore: (select: (s: typeof state) => unknown) => select(state) };
});

const { useAttachableSkills, useGrantableConnectors, useKnowledgeLibrary } = await import(
  '../use-agent-editor-options'
);
const { usePendingAgentApprovals } = await import('../use-agent-approvals');
const { useAgentThreads } = await import('../use-agent-threads');
const { useAgentTeams } = await import('../use-agent-teams');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | null = null;

async function mount(hook: () => unknown): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Probe() {
    hook();
    return null;
  }
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
  getRequest.mockClear();
  loadFiles.mockClear();
});

const hooks: [string, () => unknown][] = [
  ['useAttachableSkills', () => useAttachableSkills()],
  ['useGrantableConnectors', () => useGrantableConnectors('agent-1')],
  ['usePendingAgentApprovals', () => usePendingAgentApprovals('agent-1')],
  ['useAgentThreads', () => useAgentThreads('agent-1')],
  ['useAgentTeams', () => useAgentTeams()],
];

describe('signed out, the account’s own lists are not asked for', () => {
  for (const [name, hook] of hooks) {
    it(`${name} sends nothing signed out and asks signed in`, async () => {
      auth.isAuthenticated = false;
      await mount(hook);
      expect(getRequest).not.toHaveBeenCalled();
      act(() => renderer?.unmount());
      renderer = null;

      auth.isAuthenticated = true;
      await mount(hook);
      expect(getRequest).toHaveBeenCalled();
    });
  }

  it('useKnowledgeLibrary loads the library only for an account', async () => {
    auth.isAuthenticated = false;
    await mount(() => useKnowledgeLibrary());
    expect(loadFiles).not.toHaveBeenCalled();
    act(() => renderer?.unmount());
    renderer = null;

    auth.isAuthenticated = true;
    await mount(() => useKnowledgeLibrary());
    expect(loadFiles).toHaveBeenCalledTimes(1);
  });
});
