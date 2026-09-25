import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sidebar's tree, driven through its own menus.
 *
 * Bloom's `Sidebar` is replaced by a probe that keeps the props it was handed,
 * so what is asserted is exactly what Alia gives Bloom: the folders of the
 * tree, their rows and the `actions` beside them. The menus are real Alia
 * components over host-element stand-ins for Bloom's dropdown and dialog, and
 * the stores are the real account-scoped ones over an in-memory AsyncStorage —
 * so "pin" is proven by the chat moving to Pinned AND the pin landing under
 * this account's key, not by a spy being called.
 */

const state = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  sidebarProps: null as null | Record<string, any>,
  conversations: [] as any[],
  isLoading: false,
  agents: [] as any[],
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => state.storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      state.storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      state.storage.delete(key);
    }),
  },
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    View: host('View'),
    Linking: { openURL: vi.fn() },
    Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web },
  };
});

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: state.push, replace: state.replace }),
  usePathname: () => '/',
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ getQueryData: vi.fn(), setQueryData: vi.fn(), prefetchQuery: vi.fn() }),
}));

vi.mock('@oxy.so/services', () => ({
  ProfileButton: () => null,
  useAuth: () => ({ signIn: vi.fn() }),
  useOxy: () => ({ isAuthenticated: true, user: { id: 'user-a' }, showBottomSheet: vi.fn() }),
}));

vi.mock('@alia.onl/sdk', () => ({ IdentityMark: () => null }));
vi.mock('@/features/onboarding/ui/invite-dialog', () => ({ InviteDialog: () => null }));
vi.mock('@/features/projects/ui/project-edit-dialog', () => ({ ProjectEditDialog: () => null }));
vi.mock('@/features/settings/ui/settings-context', () => ({
  useAliaSettings: () => ({ open: vi.fn() }),
}));

vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/features/chat/runtime/use-conversations', () => ({
  useConversations: () => ({
    data: state.isLoading ? undefined : { pages: [{ conversations: state.conversations }] },
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    isLoading: state.isLoading,
  }),
  prefetchConversation: vi.fn(),
  useDeleteConversation: () => ({ mutateAsync: vi.fn() }),
  useRenameConversation: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/features/agents/runtime/use-my-agents', () => ({ useMyAgents: () => ({ data: state.agents }) }));
vi.mock('@/features/notifications/runtime/use-notifications', () => ({ useUnreadCount: () => ({ data: undefined }) }));

// Glyphs are only handed to Bloom, never drawn here.
vi.mock('@oxy.so/bloom/icons/RiAddFill', () => ({ RiAddFill: () => null }));
vi.mock('@oxy.so/bloom/icons/RiAddLine', () => ({ RiAddLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiBookOpenLine', () => ({ RiBookOpenLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiCustomerServiceLine', () => ({ RiCustomerServiceLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiFileTextLine', () => ({ RiFileTextLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiGiftLine', () => ({ RiGiftLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiListCheck3', () => ({ RiListCheck3: () => null }));
vi.mock('@oxy.so/bloom/icons/RiMicLine', () => ({ RiMicLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiMoreFill', () => ({ RiMoreFill: () => null }));
vi.mock('@oxy.so/bloom/icons/RiNotification3Line', () => ({ RiNotification3Line: () => null }));
vi.mock('@oxy.so/bloom/icons/RiRobot2Line', () => ({ RiRobot2Line: () => null }));
vi.mock('@oxy.so/bloom/icons/RiSettings4Line', () => ({ RiSettings4Line: () => null }));
vi.mock('@oxy.so/bloom/icons/RiShieldLine', () => ({ RiShieldLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiSmartphoneLine', () => ({ RiSmartphoneLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiSparklingLine', () => ({ RiSparklingLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiTimeLine', () => ({ RiTimeLine: () => null }));

vi.mock('@oxy.so/bloom/ai-chat', () => ({ useAiChatShell: () => null }));
vi.mock('@oxy.so/bloom/surfaces', () => ({ confirm: vi.fn(async () => true) }));
vi.mock('@oxy.so/bloom/sidebar', () => ({
  Sidebar: (props: Record<string, any>) => {
    state.sidebarProps = props;
    const React = require('react');
    // The tree's own actions and every row's and folder's actions, mounted so
    // their menus can be pressed.
    return React.createElement(
      'Sidebar',
      null,
      props.tree?.actions,
      props.content,
      ...(props.tree?.folders ?? []).flatMap((folder: any) => [
        React.createElement('Folder', { key: folder.key, folderKey: folder.key }, folder.actions),
        ...folder.items.map((item: any) =>
          React.createElement('Row', { key: `${folder.key}/${item.key}`, rowKey: item.key }, item.actions),
        ),
      ]),
    );
  },
}));

vi.mock('@oxy.so/bloom/dropdown-menu', async () => {
  const ReactModule = await import('react');
  const host =
    (name: string) =>
    ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement(name, props, children);
  return {
    DropdownMenu: host('Menu'),
    DropdownMenuTrigger: host('Trigger'),
    DropdownMenuContent: host('MenuContent'),
    DropdownMenuItem: host('MenuItem'),
    DropdownMenuSeparator: host('Separator'),
    DropdownMenuSub: host('Sub'),
    DropdownMenuSubTrigger: host('SubTrigger'),
    DropdownMenuSubContent: host('SubContent'),
    DropdownMenuRadioGroup: host('RadioGroup'),
    DropdownMenuRadioItem: host('RadioItem'),
  };
});
vi.mock('@oxy.so/bloom/dialog', async () => {
  const ReactModule = await import('react');
  return {
    Dialog: ({
      open,
      title,
      actions,
      children,
    }: React.PropsWithChildren<{ open: boolean; title: string; actions: any[] }>) =>
      open
        ? ReactModule.createElement(
            'Dialog',
            { title },
            children,
            actions.map((action) =>
              ReactModule.createElement('DialogAction', { key: action.label, ...action }),
            ),
          )
        : null,
  };
});
vi.mock('@oxy.so/bloom/text-field', async () => {
  const ReactModule = await import('react');
  return { TextFieldInput: (props: Record<string, unknown>) => ReactModule.createElement('TextField', props) };
});
vi.mock('@oxy.so/bloom/button', async () => {
  const ReactModule = await import('react');
  return { Button: (props: Record<string, unknown>) => ReactModule.createElement('Button', props) };
});
vi.mock('@oxy.so/bloom/loading', async () => {
  const ReactModule = await import('react');
  return { Loading: () => ReactModule.createElement('Spinner') };
});
vi.mock('@oxy.so/bloom/skeleton', async () => {
  const ReactModule = await import('react');
  return { Box: () => ReactModule.createElement('SkeletonBox') };
});
vi.mock('@oxy.so/bloom/typography', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children }: React.PropsWithChildren) => ReactModule.createElement('Text', null, children),
  };
});

import { Sidebar } from '../sidebar';
import { useFavoritesStore } from '@/features/projects/runtime/favorites-store';
import { useFoldersStore } from '@/features/projects/runtime/folders-store';
import { useStore } from '@/features/chat/runtime/global-store';
import { usePinnedStore } from '@/features/projects/runtime/pinned-store';
import { useProjectsStore } from '@/features/projects/runtime/projects-store';

const NOW = new Date();

function chat(id: string): Record<string, unknown> {
  return { id, title: id, createdAt: NOW, updatedAt: NOW, messages: [], agentId: null };
}

let renderer: ReactTestRenderer;

async function mount() {
  await act(async () => {
    renderer = create(<Sidebar />);
  });
}

/** Let the stores' persist-then-publish writes land and the sidebar re-render. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const folderItems = () =>
  Object.fromEntries(
    (state.sidebarProps!.tree.folders as any[]).map((folder) => [
      folder.key,
      folder.items.map((item: any) => item.key),
    ]),
  );

/** Whether a node is the host-element stand-in `name`. */
const is = (node: ReactTestInstance, name: string) => (node.type as unknown) === name;

/** The menu item with this label inside `scope`. */
function menuItem(scope: ReactTestInstance, label: string): ReactTestInstance {
  return scope.find((node) => is(node, 'MenuItem') && node.props.children === label);
}

const row = (key: string) =>
  renderer.root.find((node) => is(node, 'Row') && node.props.rowKey === key);

beforeEach(async () => {
  state.storage.clear();
  state.sidebarProps = null;
  state.conversations = [chat('alpha'), chat('beta')];
  state.isLoading = false;
  state.agents = [];
  useStore.setState({ streamingChatId: null, chatId: null });
  await useProjectsStore.getState().loadProjects('user-a');
  await useFoldersStore.getState().loadFolders('user-a');
  await usePinnedStore.getState().loadPinned('user-a');
  await useFavoritesStore.getState().loadFavorites('user-a');
});

afterEach(() => {
  act(() => renderer?.unmount());
});

describe('the sidebar tree', () => {
  it('puts a pinned chat under Pinned, out of History, and keeps it for this account', async () => {
    await mount();
    expect(folderItems()).toEqual({ 'history:today': ['alpha', 'beta'] });

    await act(async () => {
      menuItem(row('beta'), 'sidebar.pin').props.onPress();
    });
    await settle();

    expect(folderItems()).toEqual({ pinned: ['beta'], 'history:today': ['alpha'] });
    expect(JSON.parse(state.storage.get('alia-pinned-conversations:user-a')!)).toEqual(['beta']);
    // The same menu now offers the way back.
    await act(async () => {
      menuItem(row('beta'), 'sidebar.unpin').props.onPress();
    });
    await settle();
    expect(folderItems()).toEqual({ 'history:today': ['alpha', 'beta'] });
  });

  it('puts a favourite under Favorites and takes it back out', async () => {
    await mount();
    await act(async () => {
      menuItem(row('alpha'), 'sidebar.addFavorite').props.onPress();
    });
    await settle();
    expect(folderItems()).toEqual({ favorites: ['alpha'], 'history:today': ['beta'] });
    expect(JSON.parse(state.storage.get('alia-favorite-conversations:user-a')!)).toEqual(['alpha']);

    await act(async () => {
      menuItem(row('alpha'), 'sidebar.removeFavorite').props.onPress();
    });
    await settle();
    expect(folderItems()).toEqual({ 'history:today': ['alpha', 'beta'] });
  });

  it('creates a folder from the tree\'s "+" and files a chat in it', async () => {
    await mount();
    await act(async () => {
      menuItem(renderer.root, 'sidebar.newFolder').props.onPress();
    });
    const field = renderer.root.findByType('TextField' as any);
    await act(async () => {
      field.props.onValueChange('  Work  ');
    });
    await act(async () => {
      renderer.root
        .find((node) => is(node, 'DialogAction') && node.props.label === 'common.create')
        .props.onPress();
    });
    await settle();

    const [folder] = useFoldersStore.getState().folders;
    expect(folder?.name).toBe('Work');
    expect(state.storage.get('alia-folders:user-a')).toContain('"Work"');
    expect(state.sidebarProps!.tree.folders.map((f: any) => [f.key, f.label])).toContainEqual([
      `folder:${folder!.id}`,
      'Work',
    ]);

    // Filing it takes it out of History and into the folder.
    await act(async () => {
      row('alpha')
        .find((node) => is(node, 'RadioGroup') && node.props.value === '')
        .props.onValueChange(folder!.id);
    });
    await settle();
    expect(folderItems()).toEqual({ [`folder:${folder!.id}`]: ['alpha'], 'history:today': ['beta'] });
  });

  it('marks the chat being answered, and shows ghost rows while history loads', async () => {
    useStore.setState({ streamingChatId: 'beta' });
    await mount();
    expect(row('beta').findAllByType('Spinner' as any)).toHaveLength(1);
    expect(row('alpha').findAllByType('Spinner' as any)).toHaveLength(0);
    act(() => renderer.unmount());

    state.isLoading = true;
    await mount();
    expect(renderer.root.findAllByType('SkeletonBox' as any).length).toBeGreaterThan(0);
  });

  it('lists the agents, each opening its thread by handle', async () => {
    state.agents = [{ id: 'a1', name: 'Pepe', handle: 'pepe', lastMessageAt: null }];
    await mount();
    expect(folderItems().agents).toEqual(['agent:pepe']);
    act(() => {
      state.sidebarProps!.onTreeItemPress({ key: 'agent:pepe' });
    });
    expect(state.push).toHaveBeenCalledWith({
      pathname: '/(app)/[username]',
      params: { username: '@pepe' },
    });
  });

  it('keeps the links in the account menu signed in, so only Settings is a row under the history', async () => {
    await mount();
    const props = state.sidebarProps as Record<string, any>;
    expect(props.secondaryItems.map((item: { key: string }) => item.key)).toEqual(['settings']);
    const footer = props.footer({ collapsed: false });
    const keys = footer.props.menuItems.map((item: { key: string }) => item.key);
    expect(keys).toEqual(expect.arrayContaining(['upgrade', 'invite', 'support', 'privacy', 'terms']));
  });
});
