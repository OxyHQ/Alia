import type React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The page a channel's notice opens (`channels/reauthorize`): arriving is the tap. Signed in, it
 * renews every channel that needs the person, once; signed out, it asks them to sign in first; it
 * says what happened, and offers another try when a channel still needs them.
 */

const auth = vi.hoisted(() => ({
  isAuthenticated: true,
  isAuthResolved: true,
  signIn: vi.fn(async () => {}),
}));
const renewal = vi.hoisted(() => ({
  mutate: vi.fn(),
  data: undefined as undefined | { renewed: unknown[]; failed: unknown[] },
  isError: false,
}));

vi.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => auth }));
vi.mock('@gemies/sdk/accounts', () => ({ useReauthorizeChannels: () => renewal }));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('expo-router', async () => {
  const ReactModule = await import('react');
  return {
    Stack: { Screen: () => ReactModule.createElement('StackScreen') },
    useRouter: () => ({ replace: vi.fn() }),
  };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    ScrollView: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement('ScrollView', null, children),
  };
});
vi.mock('@/shared/ui/skeletons', async () => {
  const ReactModule = await import('react');
  return { StatusSkeleton: () => ReactModule.createElement('StatusSkeleton') };
});
vi.mock('@oxy.so/bloom/empty-state', async () => {
  const ReactModule = await import('react');
  return {
    EmptyState: (props: Record<string, unknown>) => ReactModule.createElement('EmptyState', props),
  };
});
vi.mock('@oxy.so/bloom/icons/RiCheckboxCircleLine', () => ({ RiCheckboxCircleLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiErrorWarningLine', () => ({ RiErrorWarningLine: () => null }));

import ReauthorizeChannelsScreen from '../channels/reauthorize';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let tree: ReactTestRenderer | undefined;
async function mount() {
  await act(async () => {
    tree = create(<ReauthorizeChannelsScreen />);
  });
  return tree as ReactTestRenderer;
}
const is = (name: string) => (node: ReactTestInstance) => (node.type as unknown) === name;
const states = (root: ReactTestRenderer) =>
  root.root.findAll(is('EmptyState')).map((node) => node.props.title);

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAuthenticated = true;
  auth.isAuthResolved = true;
  renewal.data = undefined;
  renewal.isError = false;
});
afterEach(() => {
  act(() => tree?.unmount());
  tree = undefined;
});

describe('the one tap', () => {
  it('renews once on arrival, drawing the shape of its answer meanwhile', async () => {
    const root = await mount();
    await act(async () => {
      root.update(<ReauthorizeChannelsScreen />);
    });
    expect(renewal.mutate).toHaveBeenCalledTimes(1);
    expect(root.root.findAll(is('StatusSkeleton'))).toHaveLength(1);
  });

  it('asks a signed-out person to sign in first, and renews nothing yet', async () => {
    auth.isAuthenticated = false;
    await mount();
    expect(auth.signIn).toHaveBeenCalledTimes(1);
    expect(renewal.mutate).not.toHaveBeenCalled();
  });

  it('says it is done, or what still needs them with another try', async () => {
    renewal.data = { renewed: [{ kind: 'account', id: 'a' }], failed: [] };
    expect(states(await mount())).toEqual(['pages.channelReauthorize.doneTitle']);
    act(() => tree?.unmount());

    renewal.data = { renewed: [], failed: [{ kind: 'bot_link', id: 'b' }] };
    const root = await mount();
    expect(states(root)).toEqual(['pages.channelReauthorize.failedTitle']);
    const retry = root.root.find(is('EmptyState')).props.action;
    act(() => retry.onPress());
    expect(renewal.mutate).toHaveBeenCalledTimes(3);
  });
});
