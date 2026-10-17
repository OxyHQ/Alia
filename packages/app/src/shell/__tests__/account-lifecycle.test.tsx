import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #608 §4: signing out or switching accounts leaves nothing of the previous
 * account on screen, and a read still in flight for it cannot put it back.
 */

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void storage.set(key, value),
    removeItem: async (key: string) => void storage.delete(key),
  },
}));
vi.mock('@oxy.so/services', () => ({
  queryKeys: { accounts: { all: ['accounts'] }, sessions: { all: ['sessions'] } },
}));
vi.mock('@oxy.so/services/ui/client', () => ({ useOxy: () => ({}) }));
// The SDK reads the host's app assertion from here (ADR 0021); this host has none.
vi.mock('@oxy.so/services/ui', () => ({
  useAppAssertion: () => ({
    getAppAssertion: async () => null,
    getAppAssertionHeaders: async () => ({}),
  }),
}));
vi.mock('@/shared/i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { useConversationStore, useThoughtStore } from '@alia.onl/sdk/runtime';
import { useStore } from '@/features/chat/runtime/global-store';
import { useUIStore } from '@/features/chat/runtime/ui-store';
import { useLibraryStore } from '@/features/library/runtime/library-store';
import { useUserDataStore } from '@/features/memory/runtime/user-data-store';
import { useShowStore } from '@/features/shows/runtime/show-store';
import { offlineConversations } from '@/features/chat/runtime/offline-conversations';
import { currentAccountEpoch, isCurrentAccountEpoch } from '@/shared/state/account-epoch';
import { resetAccountSession, useAccountLifecycle } from '@/shell/account-lifecycle';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const message = { id: 'm1', role: 'user' as const, content: 'account A’s secret' };

function seedAccountA(client: QueryClient) {
  useUIStore.setState({
    sidebarOpen: false,
    rightPanelWidth: 480,
    rightPanel: 'thought',
    canvasArtifacts: [{ id: 'a1' } as never],
  });
  useThoughtStore.getState().open('m1', {
    conversationId: 'c1',
    messages: [message],
    status: 'ready',
    isLoading: false,
    failedTurn: null,
  });
  useConversationStore.setState({
    pendingInitialMessage: {
      conversationId: 'c1',
      content: 'hi',
      text: 'hi',
      attachments: [],
      mcpServerId: null,
      skillNames: [],
    },
  });
  useStore.setState({ ghostMode: true });
  useUserDataStore.setState({ memory: { memories: [{ _id: 'x' }] } as never });
  useLibraryStore.setState({ files: [{ _id: 'f1' } as never] });
  useShowStore.setState({ series: [{ id: 's1' } as never] });
  client.setQueryData(['conversations'], { pages: [{ conversations: [{ id: 'c1' }] }] });
  client.setQueryData(['accounts', 'current'], { id: 'A' });
}

function expectNothingOfA() {
  const ui = useUIStore.getState();
  expect(ui.rightPanel).toBeNull();
  expect(useThoughtStore.getState().selection).toBeNull();
  expect(ui.canvasArtifacts).toEqual([]);
  expect(useConversationStore.getState().pendingInitialMessage).toBeNull();
  expect(useStore.getState().ghostMode).toBe(false);
  expect(useUserDataStore.getState().memory).toBeNull();
  expect(useLibraryStore.getState().files).toEqual([]);
  expect(useShowStore.getState().series).toEqual([]);
}

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient();
  storage.clear();
});

describe('resetAccountSession', () => {
  it('empties every store that held the previous account, and keeps the device’s layout', () => {
    seedAccountA(client);
    resetAccountSession(client, null);
    expectNothingOfA();
    // The device's, not the account's.
    expect(useUIStore.getState().sidebarOpen).toBe(false);
    expect(useUIStore.getState().rightPanelWidth).toBe(480);
  });

  it('on a switch, drops Alia’s cached answers and leaves Oxy’s own to Oxy', async () => {
    seedAccountA(client);
    resetAccountSession(client, 'B');
    await vi.waitFor(() => expect(client.getQueryData(['conversations'])).toBeUndefined());
    expect(client.getQueryData(['accounts', 'current'])).toEqual({ id: 'A' });
  });

  it('retires the epoch a read in flight for the previous account took', () => {
    const taken = currentAccountEpoch();
    resetAccountSession(client, 'B');
    expect(isCurrentAccountEpoch(taken)).toBe(false);
  });
});

describe('useAccountLifecycle', () => {
  let renderer: ReactTestRenderer | null = null;
  function Probe({ userId }: { userId: string | null }) {
    useAccountLifecycle(userId);
    return null;
  }
  const render = (userId: string | null) =>
    act(async () => {
      const tree = (
        <QueryClientProvider client={client}>
          <Probe userId={userId} />
        </QueryClientProvider>
      );
      if (renderer) renderer.update(tree);
      else renderer = create(tree);
    });
  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = null;
  });

  it('clears on a sign-out', async () => {
    await render('A');
    seedAccountA(client);
    await render(null);
    expectNothingOfA();
  });

  it('keeps what was there on a first sign-in from signed out', async () => {
    await render(null);
    useStore.setState({ ghostMode: true });
    await render('A');
    expect(useStore.getState().ghostMode).toBe(true);
  });
});

describe('the offline copy of the conversations', () => {
  it('belongs to one account', async () => {
    offlineConversations.bind('A');
    await offlineConversations.setItem(JSON.stringify([{ id: 'c1', title: 'A’s chat' }]));
    offlineConversations.bind('B');
    expect(await offlineConversations.getItem()).toBeNull();
    offlineConversations.bind(null);
    expect(await offlineConversations.getItem()).toBeNull();
  });
});
