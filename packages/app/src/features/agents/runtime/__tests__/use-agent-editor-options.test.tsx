import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the agent editor offers to attach, as the hooks the editor now calls
 * instead of the effects it used to run itself.
 *
 * The request is what is doubled — answered the way the routes answer, or
 * refused — and what is checked is what the editor would be handed.
 */

const getRequest = vi.hoisted(() => vi.fn());

vi.mock('@/shared/api/client', () => ({
  default: { get: getRequest, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/features/library/runtime/library-store', () => ({
  useLibraryStore: (select: (s: unknown) => unknown) =>
    select({ files: [], loadFiles: () => undefined }),
}));

const {
  linkedFileFrom,
  mergeSkillsById,
  unlinkedFiles,
  unlinkedSkills,
  useAttachableSkills,
  useGrantableConnectors,
} = await import('../use-agent-editor-options');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const skill = (id: string, displayName: string, name = displayName.toLowerCase()) => ({
  _id: id,
  name,
  displayName,
  icon: null,
  color: null,
});
const file = (id: string, name: string) => ({
  _id: id,
  name,
  type: 'application/pdf',
  category: 'documents' as const,
  url: `https://x/${name}`,
  size: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

let renderer: ReactTestRenderer | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Render a hook under a fresh query client and return a reader of its latest value. */
async function renderHook<T>(hook: () => T): Promise<() => T> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latest: T | undefined;
  function Probe() {
    latest = hook();
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
  return () => latest as T;
}

beforeEach(() => {
  getRequest.mockReset();
});
afterEach(() => {
  if (renderer !== null) act(() => renderer?.unmount());
  renderer = null;
});

describe('useAttachableSkills', () => {
  it('is the catalogue and the caller’s own, one entry per id', async () => {
    getRequest.mockImplementation(async (url: string) =>
      url === '/skills'
        ? { data: { skills: [skill('a', 'Research'), skill('b', 'Brief')] } }
        : { data: { skills: [skill('b', 'Brief (mine)'), skill('c', 'Mine')] } },
    );
    const read = await renderHook(() => useAttachableSkills());
    expect(read().data?.map((entry) => entry.displayName)).toEqual([
      'Research',
      'Brief (mine)',
      'Mine',
    ]);
  });

  it('keeps the half that answered when the other is refused', async () => {
    getRequest.mockImplementation(async (url: string) => {
      if (url === '/skills') throw new Error('offline');
      return { data: { skills: [skill('c', 'Mine')] } };
    });
    const read = await renderHook(() => useAttachableSkills());
    expect(read().isError).toBe(false);
    expect(read().data?.map((entry) => entry._id)).toEqual(['c']);
  });
});

describe('useGrantableConnectors', () => {
  it('asks with the edited agent left out, and is empty rather than failed on a refusal', async () => {
    getRequest.mockRejectedValue(new Error('boom'));
    const read = await renderHook(() => useGrantableConnectors('agent-1'));
    expect(getRequest).toHaveBeenCalledWith('/agents/capability-connectors?agent=agent-1');
    expect(read().isError).toBe(false);
    expect(read().data).toEqual([]);
  });
});

describe('the pickers’ lists', () => {
  it('offer only skills not linked yet, matched on display name or name', () => {
    const all = [skill('a', 'Research'), skill('b', 'Deep Brief', 'brief'), skill('c', 'Other')];
    expect(unlinkedSkills(all, [all[0]], '').map((s) => s._id)).toEqual(['b', 'c']);
    expect(unlinkedSkills(all, [], 'DEEP').map((s) => s._id)).toEqual(['b']);
    expect(unlinkedSkills(all, [], 'brief').map((s) => s._id)).toEqual(['b']);
  });

  it('offer only files not linked yet, matched on name, and link them by their row fields', () => {
    const all = [file('f1', 'Handbook.pdf'), file('f2', 'Notes.pdf')];
    expect(unlinkedFiles(all, [linkedFileFrom(all[0])], '').map((f) => f._id)).toEqual(['f2']);
    expect(unlinkedFiles(all, [], 'hand').map((f) => f._id)).toEqual(['f1']);
    expect(linkedFileFrom(all[0])).toEqual({
      _id: 'f1',
      name: 'Handbook.pdf',
      type: 'application/pdf',
      category: 'documents',
      url: 'https://x/Handbook.pdf',
    });
  });

  it('merge later lists over earlier ones by id', () => {
    expect(
      mergeSkillsById([skill('a', 'A')], [skill('a', 'A2'), skill('b', 'B')]).map(
        (s) => s.displayName,
      ),
    ).toEqual(['A2', 'B']);
  });
});
