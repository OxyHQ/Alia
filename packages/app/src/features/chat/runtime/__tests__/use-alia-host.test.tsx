import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { AliaRuntimeHost } from '@alia.onl/sdk/runtime';

/**
 * What the app does when a server tool finishes: the tools that change what other screens show
 * (the memory document, the person's own agents) refresh it, and the rest touch nothing.
 */

const invalidated: unknown[] = [];

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: ({ queryKey }: { queryKey: unknown }) => {
      invalidated.push(queryKey);
      return Promise.resolve();
    },
    setQueryData: vi.fn(),
  }),
}));
vi.mock('expo-router', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@clarity.surf/sdk', () => ({ resolveFaviconUrl: () => undefined }));
vi.mock('@oxy.so/bloom/hooks', () => ({ useHaptics: () => () => undefined }));
vi.mock('@/features/chat/runtime/global-store', () => ({ useStore: { getState: () => ({}) } }));
vi.mock('@/features/chat/runtime/model-store', () => ({ useModelStore: { getState: () => ({}) } }));
vi.mock('@/features/chat/runtime/use-agent-row-preview', () => ({
  useAgentRowPreview: () => vi.fn(),
}));
vi.mock('@/features/chat/runtime/ui-store', () => ({ useUIStore: { getState: () => ({}) } }));
vi.mock('@/features/memory/runtime/use-user-data', () => ({
  USER_MEMORY_QUERY_KEY: ['user-memory'],
}));
vi.mock('@/features/notifications/runtime/notifications-socket', () => ({
  acquireNotificationsSocket: vi.fn(() => ({
    socket: { on: vi.fn(), off: vi.fn() },
    release: vi.fn(),
  })),
}));
vi.mock('@/shared/platform/device-info', () => ({ collectDeviceInfo: () => ({}) }));

import { acquireNotificationsSocket } from '@/features/notifications/runtime/notifications-socket';
import { useAliaHost } from '@/features/chat/runtime/use-alia-host';
import { queryKeys } from '@/shared/api/query-keys';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function host(): AliaRuntimeHost {
  let value!: AliaRuntimeHost;
  const Probe = () => {
    value = useAliaHost();
    return null;
  };
  act(() => {
    create(<Probe />);
  });
  return value;
}

const finish = (name: string) =>
  host().onToolResult?.({ toolCallId: 't1', name, output: {} } as never);

describe('a group chat’s room', () => {
  it('listens to group:event on the notifications socket for its own conversation only, and lets go', () => {
    const handlers = new Map<string, (event: unknown) => void>();
    const release = vi.fn();
    const socket = {
      on: vi.fn((name: string, fn: (event: unknown) => void) => handlers.set(name, fn)),
      off: vi.fn((name: string) => handlers.delete(name)),
    };
    vi.mocked(acquireNotificationsSocket).mockReturnValueOnce({ socket, release } as never);
    const listener = vi.fn();
    const unsubscribe = host().subscribeRoomEvents?.('c1', listener);
    expect(socket.on).toHaveBeenCalledWith('group:event', expect.any(Function));

    const mine = { conversationId: 'c1', chainId: 'p', event: 'group.idle', data: {} };
    handlers.get('group:event')?.(mine);
    handlers.get('group:event')?.({ ...mine, conversationId: 'other' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(mine);

    unsubscribe?.();
    expect(socket.off).toHaveBeenCalledWith('group:event', expect.any(Function));
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('saved message reactions', () => {
  it('subscribes only to the requested conversation and releases the socket', () => {
    const handlers = new Map<string, (event: unknown) => void>();
    const release = vi.fn();
    const socket = {
      on: vi.fn((name: string, fn: (event: unknown) => void) => handlers.set(name, fn)),
      off: vi.fn((name: string) => handlers.delete(name)),
    };
    vi.mocked(acquireNotificationsSocket).mockReturnValueOnce({ socket, release } as never);
    const listener = vi.fn();
    const unsubscribe = host().subscribeConversationReactions?.('c1', listener);
    const update = {
      conversationId: 'c1',
      messageId: 'm1',
      reactions: ['❤️'],
      revision: 1,
      mutationId: 'mutation-1',
    };
    handlers.get('conversation:reaction')?.(update);
    handlers.get('conversation:reaction')?.({ ...update, conversationId: 'other' });
    expect(listener).toHaveBeenCalledExactlyOnceWith(update);
    unsubscribe?.();
    expect(socket.off).toHaveBeenCalledWith('conversation:reaction', expect.any(Function));
    expect(release).toHaveBeenCalledOnce();
  });
});

describe('a server tool finishing', () => {
  it('refreshes the sidebar’s agents when Alia creates or changes one', () => {
    for (const name of ['createAgent', 'updateAgent']) {
      invalidated.length = 0;
      finish(name);
      expect(invalidated, name).toContainEqual(queryKeys.agents.mine);
    }
  });

  it('refreshes the memory document when it is rewritten, and nothing for other tools', () => {
    invalidated.length = 0;
    finish('saveUserMemory');
    expect(invalidated).toEqual([['user-memory']]);
    invalidated.length = 0;
    finish('webSearch');
    expect(invalidated).toEqual([]);
  });
});
