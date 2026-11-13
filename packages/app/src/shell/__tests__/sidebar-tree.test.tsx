import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type React from 'react';
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

const linking = vi.hoisted(() => ({ openURL: vi.fn() }));
const state = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  sidebarProps: null as null | Record<string, any>,
  conversations: [] as any[],
  isLoading: false,
  isFetchingNextPage: false,
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
    Linking: { openURL: linking.openURL },
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

vi.mock('@oxy.so/services/ui/client', () => ({
  ProfileButton: () => null,
  useAuth: () => ({ signIn: vi.fn() }),
  useOxy: () => ({ isAuthenticated: true, user: { id: 'user-a' }, showBottomSheet: vi.fn() }),
}));

vi.mock('@gemies/sdk', () => ({ GemieAvatar: () => null }));
vi.mock('@/features/onboarding/ui/invite-dialog', () => ({ InviteDialog: () => null }));
vi.mock('@/features/projects/ui/project-edit-dialog', () => ({ ProjectEditDialog: () => null }));
vi.mock('@/features/settings/ui/settings-context', () => ({
  useAliaSettings: () => ({ open: vi.fn() }),
}));

vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
// The conversation store is the SDK's own (the sidebar reads which row streams from it); the
// hooks that talk to the API are stubbed.
vi.mock('@gemies/sdk/runtime', async () => ({
  ...(await import('../../../../../node_modules/@gemies/sdk/src/runtime/conversation-store')),
  useConversations: () => ({
    data: state.isLoading ? undefined : { pages: [{ conversations: state.conversations }] },
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: state.isFetchingNextPage,
    isFetchNextPageError: false,
    isPending: state.isLoading,
  }),
  usePrefetchConversation: () => vi.fn(),
  useDeleteConversation: () => ({ mutateAsync: vi.fn() }),
  useRenameConversation: () => ({ mutate: vi.fn() }),
}));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@oxy.so/bloom/textarea', async () => {
  const ReactModule = await import('react');
  return {
    Textarea: (props: Record<string, unknown>) => ReactModule.createElement('Textarea', props),
  };
});
vi.mock('@/features/notifications/runtime/use-notifications', () => ({
  useUnreadCount: () => ({ data: undefined }),
}));

// Glyphs are only handed to Bloom, never drawn here.
vi.mock('@oxy.so/bloom/icons/RiPlugLine', () => ({ RiPlugLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiDeleteBinLine', () => ({ RiDeleteBinLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiEditLine', () => ({ RiEditLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiFolderLine', () => ({ RiFolderLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiPushpinLine', () => ({ RiPushpinLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiStarLine', () => ({ RiStarLine: () => null }));
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
vi.mock('@oxy.so/bloom/conversation-sidebar', () => ({
  ConversationSidebar: (props: Record<string, any>) => {
    state.sidebarProps = props;
    const React = require('react');
    // Every tree row (a section's own rows and a folder's) and every folder's and section's actions,
    // mounted so their menus can be pressed, and what sits under the flat list.
    const trees: any[] = [props.tree ?? []].flat();
    const row = (key: string, item: any) =>
      React.createElement('Row', { key, rowKey: item.key }, item.actions);
    return React.createElement(
      'Sidebar',
      null,
      trees.map((tree) => tree.actions),
      props.after,
      trees.flatMap((tree) => [
        ...(tree.items ?? []).map((item: any) => row(`${tree.key}/${item.key}`, item)),
        ...(tree.folders ?? []).flatMap((folder: any) => [
          React.createElement('Folder', { key: folder.key, folderKey: folder.key }, folder.actions),
          ...folder.items.map((item: any) => row(`${folder.key}/${item.key}`, item)),
        ]),
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
  return {
    TextFieldInput: (props: Record<string, unknown>) =>
      ReactModule.createElement('TextField', props),
  };
});
vi.mock('@oxy.so/bloom/button', async () => {
  const ReactModule = await import('react');
  return { Button: (props: Record<string, unknown>) => ReactModule.createElement('Button', props) };
});
vi.mock('@oxy.so/bloom/loading', async () => {
  const ReactModule = await import('react');
  return { Loading: () => ReactModule.createElement('Spinner') };
});
vi.mock('@oxy.so/bloom/loading', async () => {
  const ReactModule = await import('react');
  return {
    Loading: (props: Record<string, unknown>) => ReactModule.createElement('Loading', props),
  };
});
vi.mock('@oxy.so/bloom/skeleton', async () => {
  const ReactModule = await import('react');
  return {
    Box: () => ReactModule.createElement('SkeletonBox'),
    Circle: () => ReactModule.createElement('SkeletonBox'),
    Region: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement('SkeletonRegion', null, children),
  };
});
vi.mock('@oxy.so/bloom/typography', async () => {
  const ReactModule = await import('react');
  return {
    Text: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement('Text', null, children),
    Muted: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement('Text', null, children),
  };
});

import { Sidebar } from '../sidebar';
import { useFavoritesStore } from '@/features/projects/runtime/favorites-store';
import { useFoldersStore } from '@/features/projects/runtime/folders-store';
import { useConversationStore } from '@gemies/sdk/runtime';
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
    (sections().flatMap((section) => section.folders ?? []) as any[]).map((folder) => [
      folder.key,
      folder.items.map((item: any) => item.key),
    ]),
  );

/** The tree's sections, in the order the sidebar draws them: Alia's chats (when any), then projects. */
const sections = (): any[] => [state.sidebarProps!.tree ?? []].flat();

/** The flat list: what the sidebar draws as rows, in order. Alia's chats are a section instead. */
const flat = () => (state.sidebarProps!.conversations as { id: string }[]).map((row) => row.id);
/** Alia's chats: the title-only rows of the chats section. */
const chatItems = (): any[] => sections().find((section) => section.key === 'chats')?.items ?? [];
const chatIds = () => chatItems().map((item) => item.key);
/** The rendered row of a chat, whose menu is the row's own. */
const chatRowNode = (scope: ReactTestInstance, id: string) =>
  scope.find((node) => is(node, 'Row') && node.props.rowKey === id);
/** Presses one item of a chat's own menu. */
async function pressChatMenu(id: string, label: string) {
  await act(async () => {
    menuItem(chatRowNode(renderer.root, id), label).props.onPress();
  });
  await settle();
}

/** Whether a node is the host-element stand-in `name`. */
const is = (node: ReactTestInstance, name: string) => (node.type as unknown) === name;

/** The menu item with this label inside `scope`. */
function menuItem(scope: ReactTestInstance, label: string): ReactTestInstance {
  return scope.find((node) => is(node, 'MenuItem') && node.props.children === label);
}

beforeEach(async () => {
  state.storage.clear();
  state.sidebarProps = null;
  state.conversations = [chat('alpha'), chat('beta')];
  state.isLoading = false;
  state.isFetchingNextPage = false;
  linking.openURL.mockClear();
  useStore.setState({ chatId: null });
  useConversationStore.setState({ streamingConversationId: null });
  await useProjectsStore.getState().loadProjects('user-a');
  await useFoldersStore.getState().loadFolders('user-a');
  state.replace.mockClear();
  state.push.mockClear();
  await usePinnedStore.getState().loadPinned('user-a');
  await useFavoritesStore.getState().loadFavorites('user-a');
});

afterEach(() => {
  act(() => renderer?.unmount());
});

describe('the sidebar list', () => {
  it("lists Alia's chats as title-only rows in their own section, with no folders of their own", async () => {
    await mount();
    expect(flat()).toEqual([]);
    expect(sections()[0]).toMatchObject({ key: 'chats', label: 'sidebar.chats' });
    expect(chatIds()).toEqual(['alpha', 'beta']);
    // Title only: a chat row draws no avatar.
    expect(chatItems().every((item) => item.leading === undefined)).toBe(true);
    // Projects and folders are the tree's; with none, it stands empty (it holds "new project").
    expect(folderItems()).toEqual({});
    expect(sections()[1]!.key).toBe('projects');
  });

  it('puts a pinned chat first and keeps the pin for this account', async () => {
    await mount();
    await pressChatMenu('beta', 'sidebar.pin');
    expect(chatIds()).toEqual(['beta', 'alpha']);
    expect(chatItems()[0].icon).toBeDefined();
    expect(JSON.parse(state.storage.get('alia-pinned-conversations:user-a')!)).toEqual(['beta']);
    // The same menu now offers the way back: the label says unpin.
    await pressChatMenu('beta', 'sidebar.unpin');
    expect(chatIds()).toEqual(['alpha', 'beta']);
  });

  it('puts a favourite before the rest and takes it back out', async () => {
    await mount();
    await pressChatMenu('beta', 'sidebar.addFavorite');
    expect(chatIds()).toEqual(['beta', 'alpha']);
    expect(JSON.parse(state.storage.get('alia-favorite-conversations:user-a')!)).toEqual(['beta']);
    await pressChatMenu('beta', 'sidebar.removeFavorite');
    expect(chatIds()).toEqual(['alpha', 'beta']);
  });

  it('creates a folder from the tree\'s "+" and files a chat in it, out of the chats section', async () => {
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
    expect(
      sections()
        .flatMap((s) => s.folders ?? [])
        .map((f: any) => [f.key, f.label]),
    ).toContainEqual([`folder:${folder!.id}`, 'Work']);
    // The chat's menu offers the folder; filing it moves it from the chats section into the folder.
    // The chat's folder submenu is a radio group; choosing the folder files the chat in it.
    await act(async () => {
      chatRowNode(renderer.root, 'alpha')
        .find((node) => typeof node.props.onValueChange === 'function')
        .props.onValueChange(folder!.id);
    });
    await settle();
    expect(folderItems()).toEqual({ [`folder:${folder!.id}`]: ['alpha'] });
    expect(chatIds()).toEqual(['beta']);
  });

  it('marks the chat being answered, and shows ghost rows while history loads', async () => {
    useConversationStore.setState({ streamingConversationId: 'beta' });
    await mount();
    expect(
      chatRowNode(renderer.root, 'beta').findAll(
        (node) => typeof node.type === 'function' && node.type.name === 'StreamingIndicator',
      ).length,
    ).toBe(1);
    act(() => renderer.unmount());
    state.isLoading = true;
    await mount();
    expect(renderer.root.findAllByType('SkeletonBox' as any).length).toBeGreaterThan(0);
  });

  it('shows two more ghost rows, not a spinner or a line of text, while the next page of chats loads', async () => {
    state.isFetchingNextPage = true;
    await mount();
    expect(renderer.root.findAll((node) => is(node, 'Loading'))).toHaveLength(0);
    expect(renderer.root.findAllByType('SkeletonBox' as any)).toHaveLength(2);
  });

  it('lists only Alia’s chats: a gemie’s thread, a group and a space room live in Gemies', async () => {
    state.conversations = [
      chat('alpha'),
      { ...chat('with-pepe'), agentId: 'a1' },
      { ...chat('g1'), memberAgentIds: ['a1', 'a2'] },
      { ...chat('room1'), memberAgentIds: ['a1'], spaceId: 's1' },
    ];
    await mount();
    expect(sections().map((section) => section.key)).toEqual(['chats', 'projects']);
    expect(chatIds()).toEqual(['alpha']);
  });

  it('offers two tools, search and a "+" that starts a new chat with Alia, and no catalogue', async () => {
    await mount();
    const props = state.sidebarProps as Record<string, any>;
    expect(typeof props.onQueryChange).toBe('function');
    expect(props.onMarketplace).toBeUndefined();
    expect(props.createOptions).toBeUndefined();
    act(() => {
      props.onCreate();
    });
    expect(state.replace).toHaveBeenCalledWith('/');
  });

  it('filters the chats by what is typed', async () => {
    await mount();
    await act(async () => {
      state.sidebarProps!.onQueryChange('alp');
    });
    expect(chatIds()).toEqual(['alpha']);
    await act(async () => {
      state.sidebarProps!.onQueryChange('zzz');
    });
    expect(chatIds()).toEqual([]);
  });

  it('opens a chat from its row', async () => {
    await mount();
    act(() => {
      state.sidebarProps!.onTreeItemPress({ key: 'beta' });
    });
    expect(state.replace).toHaveBeenCalledWith('/c/beta');
  });

  it('keeps the links in the account menu signed in, so only Settings is a row under the history', async () => {
    await mount();
    const props = state.sidebarProps as Record<string, any>;
    expect(props.secondaryItems.map((item: { key: string }) => item.key)).toEqual(['settings']);
    const footer = props.footer({ collapsed: false });
    const items = footer.props.menuItems as { key: string; icon?: string; onPress: () => void }[];
    const keys = items.map((item) => item.key);
    expect(keys).toEqual(expect.arrayContaining(['upgrade', 'gemies', 'invite', 'support']));
    // The person's gemies are a link out to Gemies.
    act(() => items.find((item) => item.key === 'gemies')!.onPress());
    expect(linking.openURL).toHaveBeenCalledWith('https://gemies.ai');
    // The account menu's own footer links Oxy's Privacy Policy and Terms of
    // Service; rows for them as well listed each document twice.
    expect(keys).not.toContain('privacy');
    expect(keys).not.toContain('terms');
    // A row without a glyph name draws "…" in the account menu, and a name the
    // menu's subset icon font does not carry draws "?".
    const services = dirname(
      createRequire(import.meta.url).resolve('@oxy.so/services/package.json'),
    );
    const glyphs = readFileSync(join(services, 'src/ui/icons/subsetGlyphMaps.ts'), 'utf8');
    const shipped = new Set(
      [
        ...glyphs
          .slice(glyphs.indexOf('materialCommunityIconsGlyphMap'))
          .matchAll(/"([a-z0-9-]+)":/g),
      ].map((match) => match[1]),
    );
    expect(shipped.size).toBeGreaterThan(50);
    for (const item of items) expect(shipped.has(item.icon ?? '')).toBe(true);
  });
});
