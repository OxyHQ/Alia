import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An agent's thread behind the conversation on screen: paging back through it, searching it, and
 * jumping to a moment of it.
 *
 * The routes are the agent's thread routes (`/agents/thread/:handle/…`), read through the Alia API
 * as the signed-in person. A fake API records what was asked, so each case is "which page was
 * requested with which cursor" and "what the screen is handed", not React Query's own behaviour.
 */

const api = vi.hoisted(() => ({
  calls: [] as { path: string; params: Record<string, unknown> | undefined }[],
  /** The page each request is answered with, by the cursor it asked before. */
  answer: (_path: string, _params: Record<string, unknown> | undefined): unknown => ({}),
  fail: null as null | { status: number },
}));
vi.mock('../../src/runtime/api', () => ({
  AliaApiError: class AliaApiError extends Error {},
  useAliaApi: () => ({
    get: async (path: string, request?: { params?: Record<string, unknown> }) => {
      api.calls.push({ path, params: request?.params });
      if (api.fail) {
        throw Object.assign(new Error('failed'), { status: api.fail.status });
      }
      return { status: 200, data: api.answer(path, request?.params) };
    },
  }),
}));

import { useThreadView } from '../../src/hooks/useThreadView';
import { useThreadHistory } from '../../src/runtime/use-thread-history';
import { useThreadSearch } from '../../src/runtime/use-thread-search';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const wire = (id: string, conversationId: string, cursor: string) => ({
  id,
  role: 'user',
  content: id,
  conversationId,
  cursor,
});

let renderer: ReactTestRenderer | undefined;
function render<T>(use: () => T): { current: () => T } {
  let latest!: T;
  function Probe() {
    latest = use();
    return null;
  }
  act(() => {
    renderer = create(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Probe />
      </QueryClientProvider>,
    );
  });
  return { current: () => latest };
}
/** Let the fake API answer and React Query publish what it got. */
const settle = async () => {
  for (let i = 0; i < 3; i += 1)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
};

beforeEach(() => {
  api.calls = [];
  api.fail = null;
  api.answer = () => ({ messages: [], nextCursor: null });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('the history behind the conversation on screen', () => {
  it('asks for nothing until the thread has said which conversation is live', async () => {
    render(() => useThreadHistory('pepe', undefined));
    await settle();
    expect(api.calls).toEqual([]);
  });

  it('asks for nothing without a thread', async () => {
    render(() => useThreadHistory(undefined, 'c3'));
    await settle();
    expect(api.calls).toEqual([]);
  });

  it('pages backwards by the server’s cursor, dropping the live conversation’s own messages', async () => {
    api.answer = (_path, params) =>
      params?.before === undefined
        ? {
            messages: [wire('m3', 'c2', 'k3'), wire('live', 'c3', 'k4')],
            nextCursor: 'k3',
          }
        : { messages: [wire('m1', 'c1', 'k1')], nextCursor: null };
    const hook = render(() => useThreadHistory('pepe', 'c3'));
    await settle();

    expect(api.calls).toEqual([
      { path: '/agents/thread/pepe/messages', params: { limit: 50, before: undefined } },
    ]);
    expect(hook.current().messages.map((m) => m.id)).toEqual(['m3']);
    expect(hook.current().hasMore).toBe(true);

    await act(async () => {
      await hook.current().loadMore();
    });
    await settle();
    // Oldest first: the page fetched last is the one that goes on top.
    expect(hook.current().messages.map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(hook.current().hasMore).toBe(false);
    expect(api.calls[1]?.params).toMatchObject({ before: 'k3' });
  });

  it('does not ask twice for an agent the server says is not there', async () => {
    api.fail = { status: 404 };
    render(() => useThreadHistory('ghost', 'c3'));
    await settle();
    await settle();
    expect(api.calls).toHaveLength(1);
  });
});

describe('searching the thread', () => {
  it('is not a search until something is typed', async () => {
    render(() => useThreadSearch('pepe', '   '));
    await settle();
    expect(api.calls).toEqual([]);
  });

  it('asks for the trimmed words, and hands back the hits with the cursor that reaches each', async () => {
    api.answer = () => ({
      hits: [
        {
          messageId: null,
          conversationId: 'c1',
          role: 'user',
          snippet: 'the invoice',
          createdAt: '2026-03-01T09:00:00.000Z',
          cursor: 'k9',
        },
      ],
    });
    const hook = render(() => useThreadSearch('pepe', '  invoice '));
    await settle();

    expect(api.calls).toEqual([
      { path: '/agents/thread/pepe/search', params: { q: 'invoice', limit: 30 } },
    ]);
    expect(hook.current().data?.[0]?.cursor).toBe('k9');
  });
});

describe('what the thread is looking at', () => {
  it('has no history, no search and nothing to jump to on a conversation that is not a thread', async () => {
    const view = render(() => useThreadView(undefined, 'c3'));
    await settle();
    expect(view.current().history).toBeUndefined();
    expect(api.calls).toEqual([]);
  });

  it('shows the stretch around a hit, with nothing live beneath it, and leaves by going back to the latest', async () => {
    api.answer = (_path, params) =>
      params?.at === undefined
        ? { messages: [wire('m5', 'c2', 'k5')], nextCursor: null }
        : { messages: [wire('old1', 'c1', 'k1'), wire('old2', 'c1', 'k2')], nextCursor: 'k1' };
    const view = render(() => useThreadView('pepe', 'c3'));
    await settle();
    expect(view.current().jumped).toBe(false);
    expect(view.current().history?.messages.map((m) => m.id)).toEqual(['m5']);

    act(() => view.current().openSearch());
    expect(view.current().searchOpen).toBe(true);
    act(() =>
      view.current().jump({
        messageId: null,
        conversationId: 'c1',
        role: 'user',
        snippet: 'x',
        createdAt: '2026-03-01T09:00:00.000Z',
        cursor: 'k2',
      }),
    );
    await settle();

    // Opening the window closes the search over it, and the window is asked at the hit.
    expect(view.current().searchOpen).toBe(false);
    expect(view.current().jumped).toBe(true);
    expect(view.current().focusCursor).toBe('k2');
    expect(api.calls.at(-1)?.params).toMatchObject({ at: 'k2', limit: 40 });
    // The window is of the past: nothing is dropped from it.
    expect(view.current().history?.messages.map((m) => m.id)).toEqual(['old1', 'old2']);
    // And it can be read further back, because the server said there is more.
    expect(view.current().history?.loadMore).toBeTypeOf('function');

    act(() => view.current().backToLatest());
    expect(view.current().jumped).toBe(false);
    expect(view.current().focusCursor).toBeNull();
  });

  it('offers to load more only while there is more', async () => {
    api.answer = () => ({ messages: [wire('m5', 'c2', 'k5')], nextCursor: null });
    const view = render(() => useThreadView('pepe', 'c3'));
    await settle();
    expect(view.current().history?.loadMore).toBeUndefined();
  });
});
