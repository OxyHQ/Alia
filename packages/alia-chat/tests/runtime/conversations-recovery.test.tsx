import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Missing and unreachable conversations, through the real REST layer over a fake Oxy client.
 *
 * A 404 on an authenticated read is authoritative: the offline copy of that conversation must go
 * (keeping it resurrects a deleted chat and every later read hits the same missing id again),
 * and the error is the stable `ConversationNotFoundError` a screen can leave on. A 401 is a
 * session that cannot reach the server: its offline copy is what the person sees, per account.
 */

const server = vi.hoisted(() => ({
  respond: (_method: string, _url: string): { status: number; body?: unknown } => ({ status: 200 }),
  calls: [] as string[],
  apiReady: true,
  cacheReady: true,
}));

vi.mock('@oxy.so/services/ui/client', async () => ({
  ...(await import('../support/app-assertion-host')).hostWithoutAppAssertion,
  useOxy: () => ({
    isAuthenticated: true,
    canUsePrivateApi: server.apiReady,
    isAccountCacheReady: server.cacheReady,
    oxyServices: {
      createLinkedClient: () => ({
        client: {
          getSessionEpoch: () => 0,
          addTokenChangeListener: () => () => {},
          requestAuthenticatedResponse: async (config: { method: string; url: string }) => {
            server.calls.push(`${config.method} ${config.url}`);
            const { status, body } = server.respond(config.method, config.url);
            return new Response(body === undefined ? null : JSON.stringify(body), { status });
          },
        },
        dispose: () => {},
      }),
    },
  }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn() } }));

import { AliaRuntimeProvider, type OfflineConversationStore } from '../../src/runtime/config';
import {
  ConversationNotFoundError,
  useConversation,
  useConversations,
} from '../../src/runtime/conversations';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const stored = { value: null as string | null };
const offline: OfflineConversationStore = {
  getItem: async () => stored.value,
  setItem: async (value) => {
    stored.value = value;
  },
};
const copy = (id: string) => ({
  id,
  title: `offline ${id}`,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-02T00:00:00Z',
  messages: [{ id: 'm1', role: 'user', content: 'kept offline' }],
});

let renderer: ReactTestRenderer | undefined;
let rerender: () => Promise<void>;
function mount(probe: () => void) {
  function Probe() {
    probe();
    return null;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <AliaRuntimeProvider apiUrl="http://api.test" offline={offline}>
        <Probe />
      </AliaRuntimeProvider>
    </QueryClientProvider>
  );
  rerender = async () => {
    await act(async () => {
      renderer?.update(tree());
    });
  };
  return act(async () => {
    renderer = create(tree());
  });
}

beforeEach(() => {
  server.calls = [];
  server.apiReady = true;
  server.cacheReady = true;
  stored.value = JSON.stringify([copy('c1'), copy('c2')]);
});
afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe('a conversation the server no longer has', () => {
  it('is a ConversationNotFoundError, and its offline copy is dropped with it', async () => {
    server.respond = () => ({ status: 404, body: { error: 'nope' } });
    let state: ReturnType<typeof useConversation> | undefined;
    await mount(() => {
      state = useConversation('c1');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(state?.error).toBeInstanceOf(ConversationNotFoundError);
    expect(JSON.parse(stored.value ?? '[]').map((c: { id: string }) => c.id)).toEqual(['c2']);
  });
});

describe('a session the server cannot reach', () => {
  it('reads the conversation from its offline copy on a 401', async () => {
    server.respond = () => ({ status: 401, body: { error: 'expired' } });
    let state: ReturnType<typeof useConversation> | undefined;
    await mount(() => {
      state = useConversation('c1');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(state?.data?.title).toBe('offline c1');
    expect(state?.data?.messages).toHaveLength(1);
    expect(state?.data?.createdAt).toBeInstanceOf(Date);
  });

  it('lists the offline copy a page at a time on a 401', async () => {
    server.respond = () => ({ status: 401 });
    let state: ReturnType<typeof useConversations> | undefined;
    await mount(() => {
      state = useConversations();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(state?.data?.pages[0]?.conversations.map((c) => c.id)).toEqual(['c1', 'c2']);
    // The list never carries messages.
    expect(state?.data?.pages[0]?.conversations[0]?.messages).toEqual([]);
  });

  it('reports an authentication failure instead of caching an empty successful list', async () => {
    server.respond = () => ({ status: 401 });
    stored.value = null;
    let state: ReturnType<typeof useConversations> | undefined;
    await mount(() => {
      state = useConversations();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(state?.data).toBeUndefined();
    expect(state?.isError).toBe(true);
  });
});

it('waits for both the restored account cache and usable authentication, then loads immediately', async () => {
  server.apiReady = false;
  server.cacheReady = false;
  server.respond = () => ({
    status: 200,
    body: {
      conversations: [{ ...copy('online'), messages: [] }],
      hasMore: false,
      nextCursor: null,
    },
  });
  let state: ReturnType<typeof useConversations> | undefined;
  await mount(() => {
    state = useConversations();
  });
  expect(server.calls).toEqual([]);
  server.apiReady = true;
  await rerender();
  expect(server.calls).toEqual([]);
  server.cacheReady = true;
  await rerender();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(server.calls).toHaveLength(1);
  expect(state?.data?.pages[0]?.conversations[0]?.id).toBe('online');
});
