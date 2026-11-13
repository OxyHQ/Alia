import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { GemieRuntimeHost } from '@gemies/sdk/runtime';

/**
 * What the app does when a server tool finishes: the tools that change what other screens show
 * (the memory document) refresh it, and the rest touch nothing.
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
vi.mock('@/features/chat/runtime/ui-store', () => ({ useUIStore: { getState: () => ({}) } }));
vi.mock('@/features/memory/runtime/use-user-data', () => ({
  USER_MEMORY_QUERY_KEY: ['user-memory'],
}));
vi.mock('@/shared/platform/device-info', () => ({ collectDeviceInfo: () => ({}) }));

import { useAliaHost } from '@/features/chat/runtime/use-alia-host';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function host(): GemieRuntimeHost {
  let value!: GemieRuntimeHost;
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

describe('a server tool finishing', () => {
  it('refreshes the memory document when it is rewritten, and nothing for other tools', () => {
    invalidated.length = 0;
    finish('saveUserMemory');
    expect(invalidated).toEqual([['user-memory']]);
    invalidated.length = 0;
    finish('webSearch');
    expect(invalidated).toEqual([]);
  });
});
