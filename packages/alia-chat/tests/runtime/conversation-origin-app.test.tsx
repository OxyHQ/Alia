import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The app a conversation started in (`docs/agent-embedding.md` §6): the chat's `app` labels the
 * conversation it makes, and an app lists only its own by asking for them
 * (`useConversations({ app })`) — under a key of its own, so its list and the Alia app's never
 * stand in for each other.
 */

const http = vi.hoisted(() => ({
  gets: [] as { path: string; params: unknown }[],
  posts: [] as { path: string; body: Record<string, unknown> }[],
}));

vi.mock('../../src/runtime/api', () => {
  const stub = {
    get: vi.fn(async (path: string, config?: { params?: unknown }) => {
      http.gets.push({ path, params: config?.params });
      return { data: { conversations: [], nextCursor: null, hasMore: false } };
    }),
    post: vi.fn(async (path: string, body: Record<string, unknown>) => {
      http.posts.push({ path, body });
      return {
        data: {
          id: 'made',
          title: 'New chat',
          app: body.app ?? null,
          createdAt: '2026-10-17T00:00:00Z',
          updatedAt: '2026-10-17T00:00:00Z',
        },
      };
    }),
    delete: vi.fn(),
  };
  return { useAliaApi: () => stub };
});
vi.mock('@oxy.so/services/ui/client', () => ({
  // The host's app assertion (ADR 0021): none here (`tests/support/app-assertion-host.ts`).
  useAppAssertion: () => ({
    getAppAssertion: async () => null,
    getAppAssertionHeaders: async () => ({}),
  }),
  useOxy: () => ({ isAuthenticated: true }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { AliaRuntimeProvider } from '../../src/runtime/config';
import {
  useConversations,
  useCreateConversation,
  useSaveConversation,
} from '../../src/runtime/conversations';
import { aliaQueryKeys } from '../../src/runtime/query-keys';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | undefined;
let client: QueryClient;
let createConversation: ReturnType<typeof useCreateConversation>;
let saveConversation: ReturnType<typeof useSaveConversation>;

function Lists({ app }: { app?: string }) {
  useConversations(app === undefined ? {} : { app });
  createConversation = useCreateConversation();
  saveConversation = useSaveConversation();
  return null;
}

async function mount({ chatApp, listApp }: { chatApp?: string; listApp?: string }) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <AliaRuntimeProvider app={chatApp}>
          <Lists app={listApp} />
        </AliaRuntimeProvider>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  http.gets = [];
  http.posts = [];
});
afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe('useConversations({ app })', () => {
  it("asks for the app's conversations, under the app's own key", async () => {
    await mount({ chatApp: 'mercaria', listApp: 'mercaria' });
    expect(http.gets[0]?.params).toMatchObject({ app: 'mercaria' });
    expect(
      client.getQueryData(aliaQueryKeys.conversations.filtered({ app: 'mercaria' })),
    ).toBeDefined();
    expect(client.getQueryData(aliaQueryKeys.conversations.all)).toBeUndefined();
  });

  it("is every conversation without it, whatever the chat's app", async () => {
    await mount({ chatApp: 'mercaria' });
    expect(http.gets[0]?.params).not.toHaveProperty('app');
  });
});

describe("the chat's app labels the conversations it makes", () => {
  it('on create and on save', async () => {
    await mount({ chatApp: 'mercaria' });
    await act(async () => {
      await createConversation.mutateAsync({});
      await saveConversation.mutateAsync({ id: 'c1', messages: [] });
    });
    expect(http.posts.map((post) => post.body.app)).toEqual(['mercaria', 'mercaria']);
  });

  it("and Alia's own chat names none", async () => {
    await mount({});
    await act(async () => {
      await createConversation.mutateAsync({});
    });
    expect(http.posts[0]?.body).not.toHaveProperty('app');
  });
});
