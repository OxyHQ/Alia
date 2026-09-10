import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `useClearConversation` does to the query cache, and WHEN (#553).
 *
 * The cached history is the reason "Clear conversation" used to undo itself:
 * `useChatConversation` resets its screen and then, seeing a cache with
 * messages and a screen with none, hydrates the cache back in. So the
 * mutation's contract is precise about the cache:
 *
 * - on SUCCESS the detail entry's messages are emptied and its preview
 *   dropped, the list entry keeps its place and loses its preview, and both
 *   are invalidated so the server's answer replaces the local guess;
 * - on FAILURE nothing in the cache moves at all — not optimistically before
 *   the request, not as cleanup after it — because the dialog that asked for
 *   the clear promised the opposite of "it will be back".
 *
 * The API client is mocked at the module boundary; the request it must make
 * is pinned by path and method, since a clear that hit `DELETE
 * /conversations/:id` instead would remove the thread rather than empty it.
 */

const http = vi.hoisted(() => ({
  /** Every request the hook made, as `METHOD path`. */
  requests: [] as string[],
  outcome: 'ok' as 'ok' | { status: number },
}));

vi.mock('@/lib/api/client', () => ({
  default: {
    delete: vi.fn(async (path: string) => {
      http.requests.push(`DELETE ${path}`);
      if (http.outcome !== 'ok') {
        throw Object.assign(new Error(`Request failed with status code ${http.outcome.status}`), {
          isAxiosError: true,
          response: { status: http.outcome.status, data: { error: 'nope' } },
        });
      }
      return { data: { success: true } };
    }),
    get: vi.fn(),
    post: vi.fn(),
  },
}));
vi.mock('@oxy.so/services', () => ({ useOxy: () => ({ isAuthenticated: true }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) },
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useClearConversation, type Conversation } from '@/lib/hooks/use-conversations';
import { queryKeys } from '@/lib/hooks/query-keys';

let api: ReturnType<typeof useClearConversation>;
let client: QueryClient;
let renderer: ReactTestRenderer | undefined;

function Probe() {
  api = useClearConversation();
  return null;
}

const THREAD: Conversation = {
  id: 'c1',
  title: 'Capitals',
  lastMessage: 'Lima',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-02T00:00:00Z'),
  messages: [
    { id: 'u1', role: 'user', content: 'what is the capital of Peru' },
    { id: 'a1', role: 'assistant', content: 'Lima' },
  ],
};

const OTHER: Conversation = {
  id: 'c2',
  title: 'Unrelated',
  lastMessage: 'still here',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  messages: [],
};

/** A cache in the state the screen is in when the dialog is confirmed. */
function seed() {
  client.setQueryData(queryKeys.conversations.detail('c1'), THREAD);
  client.setQueryData(queryKeys.conversations.all, {
    pages: [{ conversations: [{ ...THREAD, messages: [] }, OTHER], nextCursor: null, hasMore: false }],
    pageParams: [undefined],
  });
}

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed();
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  http.requests = [];
  http.outcome = 'ok';
});

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useClearConversation', () => {
  it('sends one DELETE to the messages sub-resource, never to the conversation itself', async () => {
    await mount();

    await act(async () => { await api.mutateAsync('c1'); });

    expect(http.requests).toEqual(['DELETE /conversations/c1/messages']);
  });

  it('empties the cached thread and drops its preview on success, keeping the row', async () => {
    await mount();

    await act(async () => { await api.mutateAsync('c1'); });

    const detail = client.getQueryData<Conversation>(queryKeys.conversations.detail('c1'));
    // Empty, not gone: the title and the entry survive; only what the server
    // deleted is dropped locally.
    expect(detail).toMatchObject({ id: 'c1', title: 'Capitals', messages: [] });
    expect(detail?.lastMessage).toBeUndefined();

    const list = client.getQueryData<{ pages: { conversations: Conversation[] }[] }>(queryKeys.conversations.all);
    const entries = list?.pages[0].conversations ?? [];
    expect(entries.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(entries[0].lastMessage).toBeUndefined();
    // A neighbour is not a casualty of somebody else's clear.
    expect(entries[1].lastMessage).toBe('still here');
  });

  it('invalidates the thread and the list after emptying the cache', async () => {
    await mount();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    await act(async () => { await api.mutateAsync('c1'); });

    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toContainEqual(queryKeys.conversations.detail('c1'));
    expect(keys).toContainEqual(queryKeys.conversations.all);
  });

  it('touches nothing in the cache when the server refuses', async () => {
    http.outcome = { status: 500 };
    vi.useFakeTimers();
    await mount();

    // `retry: 1` sleeps before its second attempt; the clock is advanced past
    // it rather than waited on.
    const attempt = api.mutateAsync('c1').catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    const settled = await attempt;

    expect(settled).toBeInstanceOf(Error);
    // Tried, retried, and refused both times — and the cache is exactly as it
    // was seeded: a cleared cache under a failed clear is the bug's mirror.
    expect(http.requests).toEqual([
      'DELETE /conversations/c1/messages',
      'DELETE /conversations/c1/messages',
    ]);
    expect(client.getQueryData(queryKeys.conversations.detail('c1'))).toEqual(THREAD);
    const list = client.getQueryData<{ pages: { conversations: Conversation[] }[] }>(queryKeys.conversations.all);
    expect(list?.pages[0].conversations[0].lastMessage).toBe('Lima');
  });
});
