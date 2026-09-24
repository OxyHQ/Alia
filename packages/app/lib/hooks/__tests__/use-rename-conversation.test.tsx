import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Renaming a chat from the sidebar.
 *
 * The API has no title-only write: `POST /conversations` sets the title and
 * REPLACES the messages with what it is sent. The sidebar seeds the detail
 * cache from the list with an empty `messages` array, so a rename that saved
 * whatever the cache held would empty the thread. The contract is therefore:
 * read the thread fresh from the server, then save exactly those messages with
 * the new title.
 */

const http = vi.hoisted(() => ({
  requests: [] as string[],
  posted: [] as { conversationId: string; title?: string; messages: unknown[] }[],
}));

const SERVER_MESSAGES = [
  { id: 'u1', role: 'user', content: 'what is the capital of Peru' },
  { id: 'a1', role: 'assistant', content: 'Lima' },
];

vi.mock('@/lib/api/client', () => ({
  default: {
    get: vi.fn(async (path: string) => {
      http.requests.push(`GET ${path}`);
      return {
        data: {
          id: 'c1',
          title: 'Capitals',
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-02T00:00:00Z',
          messages: SERVER_MESSAGES,
        },
      };
    }),
    post: vi.fn(async (path: string, body: { conversationId: string; title?: string; messages: unknown[] }) => {
      http.requests.push(`POST ${path}`);
      http.posted.push(body);
      return {
        data: {
          id: body.conversationId,
          title: body.title,
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-03T00:00:00Z',
        },
      };
    }),
    delete: vi.fn(),
  },
}));
vi.mock('@oxy.so/services', () => ({ useOxy: () => ({ isAuthenticated: true }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) },
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { queryKeys } from '@/lib/hooks/query-keys';
import { useRenameConversation, type Conversation } from '@/lib/hooks/use-conversations';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let api: ReturnType<typeof useRenameConversation>;
let client: QueryClient;
let renderer: ReactTestRenderer | undefined;

function Probe() {
  api = useRenameConversation();
  return null;
}

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The seed the sidebar writes before opening a chat: the list row, no messages.
  const seed: Conversation = {
    id: 'c1',
    title: 'Capitals',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-02T00:00:00Z'),
    messages: [],
  };
  client.setQueryData(queryKeys.conversations.detail('c1'), seed);
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
  http.posted = [];
});

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe('useRenameConversation', () => {
  it('reads the thread fresh, then saves its messages under the new title', async () => {
    await mount();
    await act(async () => {
      await api.mutateAsync({ id: 'c1', title: 'Peru' });
    });

    expect(http.requests).toEqual(['GET /conversations/c1', 'POST /conversations']);
    expect(http.posted).toHaveLength(1);
    expect(http.posted[0].conversationId).toBe('c1');
    expect(http.posted[0].title).toBe('Peru');
    // Not the empty seed: the messages the server holds.
    expect(http.posted[0].messages).toHaveLength(SERVER_MESSAGES.length);
  });

  it('puts the new title in the sidebar list', async () => {
    await mount();
    await act(async () => {
      await api.mutateAsync({ id: 'c1', title: 'Peru' });
    });
    const list = client.getQueryData<{ pages: { conversations: Conversation[] }[] }>(
      queryKeys.conversations.all,
    );
    expect(list?.pages[0].conversations[0]).toMatchObject({ id: 'c1', title: 'Peru' });
  });
});
