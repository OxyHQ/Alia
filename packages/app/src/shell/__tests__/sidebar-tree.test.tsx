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

const state = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  sidebarProps: null as null | Record<string, any>,
  conversations: [] as any[],
  isLoading: false,
  isFetchingNextPage: false,
  agents: [] as any[],
  spaces: [] as any[],
  spacesLoading: false,
  mutations: {
    createSpace: { mutateAsync: vi.fn() },
    updateSpace: { mutateAsync: vi.fn() },
    deleteSpace: { mutateAsync: vi.fn() },
    moveAgent: { mutateAsync: vi.fn() },
    removeAgent: { mutateAsync: vi.fn() },
  },
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

vi.mock('@oxy.so/services/ui/client', () => ({
  ProfileButton: () => null,
  useAuth: () => ({ signIn: vi.fn() }),
  useOxy: () => ({ isAuthenticated: true, user: { id: 'user-a' }, showBottomSheet: vi.fn() }),
}));

vi.mock('@alia.onl/sdk', () => ({
  AliaAvatar: () => null,
  ALIA_AVATAR: { preset: 'blue_beret' },
  readAgentCharacter: (value: unknown) => ({ preset: 'blue_beret', value }),
}));
vi.mock('@oxy.so/bloom/agent-avatar', () => ({ AgentAvatar: () => null }));
vi.mock('@/features/onboarding/ui/invite-dialog', () => ({ InviteDialog: () => null }));
vi.mock('@/features/agents/ui/group-picker-dialog', () => ({ GroupPickerDialog: () => null }));
vi.mock('@oxy.so/bloom/agent-reply', () => ({ AgentStack: () => null }));
vi.mock('@/features/agents/runtime/use-new-agent-conversation', () => ({
  useNewAgentConversation: () => () => undefined,
}));
vi.mock('@/features/projects/ui/project-edit-dialog', () => ({ ProjectEditDialog: () => null }));
vi.mock('@/features/settings/ui/settings-context', () => ({
  useAliaSettings: () => ({ open: vi.fn() }),
}));

vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
// The conversation store is the SDK's own (the sidebar reads which row streams from it); the
// hooks that talk to the API are stubbed.
vi.mock('@alia.onl/sdk/runtime', async () => ({
  ...(await import('../../../../alia-chat/src/runtime/conversation-store')),
  useConversations: () => ({
    data: state.isLoading ? undefined : { pages: [{ conversations: state.conversations }] },
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: state.isFetchingNextPage,
    isFetchNextPageError: false,
    isLoading: state.isLoading,
  }),
  usePrefetchConversation: () => vi.fn(),
  useDeleteConversation: () => ({ mutateAsync: vi.fn() }),
  useRenameConversation: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/features/agents/runtime/use-my-agents', () => ({
  useMyAgents: () => ({ data: state.agents }),
}));
vi.mock('@/features/spaces/runtime/use-spaces', () => ({
  useSpaces: () => ({
    data: state.spacesLoading ? undefined : state.spaces,
    isLoading: state.spacesLoading,
  }),
  useSpaceMutations: () => state.mutations,
  spaceErrorCode: () => undefined,
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
import { useConversationStore } from '@alia.onl/sdk/runtime';
import { useStore } from '@/features/chat/runtime/global-store';
import { usePinnedStore } from '@/features/projects/runtime/pinned-store';
import { useProjectsStore } from '@/features/projects/runtime/projects-store';
import { useSpacesOpenStore } from '@/features/spaces/runtime/spaces-open-store';

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

/** The flat list: what the sidebar draws as rows, in order. It holds the agents (contacts). */
const flat = () => (state.sidebarProps!.conversations as { id: string }[]).map((row) => row.id);
const flatRow = (id: string) =>
  (state.sidebarProps!.conversations as any[]).find((row) => row.id === id);
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
  state.agents = [];
  state.spaces = [];
  state.spacesLoading = false;
  for (const mutation of Object.values(state.mutations)) mutation.mutateAsync.mockReset();
  useStore.setState({ chatId: null });
  useConversationStore.setState({ streamingConversationId: null });
  await useProjectsStore.getState().loadProjects('user-a');
  await useFoldersStore.getState().loadFolders('user-a');
  await useSpacesOpenStore.getState().loadSpacesOpen('user-a');
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

  it('lists a group chat with the agents, first, and not among Alia’s chats', async () => {
    state.agents = [
      { _id: 'a1', name: 'Pepe', handle: 'pepe', lastMessageAt: null },
      { _id: 'a2', name: 'Ana', handle: 'ana', lastMessageAt: null },
    ];
    state.conversations = [
      chat('alpha'),
      {
        ...chat('g1'),
        title: 'Los tres',
        lastMessage: 'Hola a todos',
        memberAgentIds: ['a1', 'a2'],
      },
    ];
    await mount();
    const agents = sections().find((section) => section.key === 'agents')!;
    // The group stands first among the contacts, a row of its own that opens the conversation.
    expect(agents.items.map((item: { key: string }) => item.key)).toEqual([
      'g1',
      'agent:a1',
      'agent:a2',
    ]);
    expect(agents.items[0]).toMatchObject({ label: 'Los tres', description: 'Hola a todos' });
    expect(chatIds()).toEqual(['alpha']);
    act(() => {
      state.sidebarProps!.onTreeItemPress({ key: 'g1' });
    });
    expect(state.replace).toHaveBeenCalledWith('/(app)/c/g1');
  });

  it('lists the agents as contacts in the flat list, each opening its thread by handle', async () => {
    state.agents = [
      {
        _id: 'a1',
        name: 'Pepe',
        handle: 'pepe',
        lastMessageAt: null,
        lastMessage: 'Sent the notes',
      },
    ];
    await mount();
    // The agents are the first titled section, with their avatars; Alia's chats follow in theirs.
    expect(flat()).toEqual([]);
    expect(sections()[0]).toMatchObject({ key: 'agents', label: 'sidebar.agents' });
    expect(sections()[0]!.items.map((item: { key: string }) => item.key)).toEqual(['agent:a1']);
    expect(sections()[0]!.items[0].label).toBe('Pepe');
    // Under the name, the last line of the thread.
    expect(sections()[0]!.items[0].description).toBe('Sent the notes');
    expect(sections()[1]).toMatchObject({ key: 'chats', label: 'sidebar.chats' });
    expect(chatIds()).toEqual(['alpha', 'beta']);
    act(() => {
      state.sidebarProps!.onTreeItemPress({ key: 'agent:a1' });
    });
    expect(state.push).toHaveBeenCalledWith({
      pathname: '/(app)/[username]',
      params: { username: '@pepe' },
    });
  });

  it('offers the three tools: search, the agents\' catalogue and "+" with its create menu', async () => {
    await mount();
    const props = state.sidebarProps as Record<string, any>;
    expect(typeof props.onQueryChange).toBe('function');
    act(() => {
      props.onMarketplace();
    });
    expect(state.push).toHaveBeenCalledWith('/(app)/agents');
    // "+" opens Bloom's create menu: a chat with Alia, a new agent, a group chat.
    expect(props.createOptions.map((option: { key: string }) => option.key)).toEqual([
      'chat',
      'agent',
      'group',
      'space',
    ]);
    act(() => {
      props.createOptions[0].onPress();
    });
    expect(state.replace).toHaveBeenCalledWith('/(app)');
  });

  it('filters the chats and the agents by what is typed', async () => {
    state.agents = [{ _id: 'a1', name: 'Pepe', handle: 'pepe', lastMessageAt: null }];
    await mount();
    await act(async () => {
      state.sidebarProps!.onQueryChange('alp');
    });
    expect(chatIds()).toEqual(['alpha']);
    expect(sections().find((section) => section.key === 'agents')).toBeUndefined();
    await act(async () => {
      state.sidebarProps!.onQueryChange('pep');
    });
    expect(chatIds()).toEqual([]);
    expect(sections()[0]!.items.map((item: { key: string }) => item.key)).toEqual(['agent:a1']);
  });

  it('keeps the links in the account menu signed in, so only Settings is a row under the history', async () => {
    await mount();
    const props = state.sidebarProps as Record<string, any>;
    expect(props.secondaryItems.map((item: { key: string }) => item.key)).toEqual(['settings']);
    const footer = props.footer({ collapsed: false });
    const items = footer.props.menuItems as { key: string; icon?: string }[];
    const keys = items.map((item) => item.key);
    expect(keys).toEqual(expect.arrayContaining(['upgrade', 'invite', 'support']));
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

const space = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'Equipo',
  instructions: '',
  conversationId: 'room1',
  memberAgentIds: ['a1', 'a2'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});
const agent = (id: string, name: string, spaceId: string | null = null) => ({
  _id: id,
  name,
  handle: name.toLowerCase(),
  lastMessageAt: null,
  spaceId,
});
const room = (over: Record<string, unknown> = {}) => ({
  ...chat('room1'),
  title: 'Equipo',
  lastMessage: 'Listo',
  memberAgentIds: ['a1', 'a2'],
  spaceId: 's1',
  ...over,
});
const spacesSection = () => sections().find((section) => section.key === 'spaces');
const keysOf = (items: { key: string }[]) => items.map((item) => item.key);
const dialogTitled = (title: string) =>
  renderer.root.findAll((n) => is(n, 'Dialog') && n.props.title === title);

describe('spaces in the sidebar', () => {
  it('draws no section when the person has no space', async () => {
    state.agents = [agent('a1', 'Pepe')];
    await mount();
    expect(spacesSection()).toBeUndefined();
  });

  it('draws one folder per space: its room first, then its agents, which leave the flat list', async () => {
    state.agents = [agent('a1', 'Pepe', 's1'), agent('a2', 'Ana', 's1'), agent('a3', 'Luis')];
    state.spaces = [space()];
    state.conversations = [chat('alpha'), room()];
    await mount();
    const section = spacesSection();
    expect(section).toMatchObject({ label: 'sidebar.spaces' });
    const [folder] = section.folders;
    expect(folder).toMatchObject({ key: 'space:s1', label: 'Equipo', open: true });
    expect(keysOf(folder.items)).toEqual(['room1', 'agent:a1', 'agent:a2']);
    expect(folder.items[0]).toMatchObject({ label: 'spaces.general', description: 'Listo' });
    // Only the agent in no space stays in the flat Agents list; the room is in neither list.
    const agents = sections().find((s) => s.key === 'agents')!;
    expect(keysOf(agents.items)).toEqual(['agent:a3']);
    expect(chatIds()).toEqual(['alpha']);
  });

  it('keeps a one-member room out of the group chats and Alia’s chats', async () => {
    state.agents = [agent('a1', 'Pepe', 's1')];
    state.spaces = [space({ memberAgentIds: ['a1'] })];
    state.conversations = [chat('alpha'), room({ memberAgentIds: ['a1'] })];
    await mount();
    expect(chatIds()).toEqual(['alpha']);
    expect(sections().find((s) => s.key === 'agents')).toBeUndefined();
  });

  it('shows an empty space as a folder with one row that opens the picker, and no room', async () => {
    state.agents = [agent('a3', 'Luis')];
    state.spaces = [space({ memberAgentIds: [] })];
    await mount();
    const [folder] = spacesSection().folders;
    expect(keysOf(folder.items)).toEqual(['space-add:s1']);
    expect(folder.items[0]).toMatchObject({ label: 'spaces.addAgents' });
    // Pressing it is not a destination.
    act(() => state.sidebarProps!.onTreeItemPress({ key: 'space-add:s1' }));
    expect(state.replace).not.toHaveBeenCalled();
    await act(async () => folder.items[0].onPress());
    expect(dialogTitled('spaces.addAgentsTitle')).toHaveLength(1);
  });

  it('opens the room like a group chat and an agent row like the flat list does', async () => {
    state.agents = [agent('a1', 'Pepe', 's1'), agent('a2', 'Ana', 's1')];
    state.spaces = [space()];
    state.conversations = [room()];
    await mount();
    act(() => state.sidebarProps!.onTreeItemPress({ key: 'room1' }));
    expect(state.replace).toHaveBeenCalledWith('/(app)/c/room1');
    act(() => state.sidebarProps!.onTreeItemPress({ key: 'agent:a1' }));
    expect(state.push).toHaveBeenCalled();
  });

  it('puts the section beside the agents, ahead of Alia’s chats', async () => {
    state.agents = [agent('a1', 'Pepe', 's1'), agent('a3', 'Luis')];
    state.spaces = [space({ memberAgentIds: ['a1'] })];
    await mount();
    expect(sections().map((s) => s.key)).toEqual(['agents', 'spaces', 'chats', 'projects']);
  });

  it('keeps the folder closed on this account once the person closes it', async () => {
    state.agents = [agent('a1', 'Pepe', 's1')];
    state.spaces = [space({ memberAgentIds: ['a1'] })];
    await mount();
    await act(async () => {
      spacesSection().folders[0].onOpenChange(false);
    });
    await settle();
    expect(spacesSection().folders[0].open).toBe(false);
    expect([...state.storage.keys()]).toContain('alia-spaces-closed:user-a');
  });

  it('draws folder-shaped ghost rows, never a spinner, while the spaces load', async () => {
    state.spacesLoading = true;
    await mount();
    expect(renderer.root.findAllByType('SkeletonRegion' as any).length).toBeGreaterThan(0);
    expect(renderer.root.findAll((node) => is(node, 'Loading'))).toHaveLength(0);
  });

  it('offers "New space" in the create menu, which opens the dialog', async () => {
    await mount();
    const option = state.sidebarProps!.createOptions.find(
      (o: { key: string }) => o.key === 'space',
    );
    expect(option.label).toBe('sidebar.create.space');
    await act(async () => option.onPress());
    expect(dialogTitled('spaces.createTitle')).toHaveLength(1);
  });

  it('gives a member’s row a menu to move it, and takes it out of its space', async () => {
    state.agents = [agent('a1', 'Pepe', 's1'), agent('a3', 'Luis')];
    state.spaces = [
      space({ memberAgentIds: ['a1'] }),
      space({ id: 's2', name: 'Otro', conversationId: 'room2', memberAgentIds: [] }),
    ];
    await mount();
    const member = spacesSection().folders[0].items.find(
      (i: { key: string }) => i.key === 'agent:a1',
    );
    const flatAgent = sections().find((s) => s.key === 'agents')!.items[0];
    expect(flatAgent.actions).toBeDefined();
    let menu!: ReactTestRenderer;
    await act(async () => {
      menu = create(member.actions);
    });
    const group = menu.root.find((n) => is(n, 'RadioGroup'));
    await act(async () => group.props.onValueChange(''));
    expect(state.mutations.removeAgent.mutateAsync).toHaveBeenCalledWith({
      spaceId: 's1',
      agentId: 'a1',
    });
    await act(async () => group.props.onValueChange('s2'));
    expect(state.mutations.moveAgent.mutateAsync).toHaveBeenCalledWith({
      spaceId: 's2',
      agentId: 'a1',
    });
  });

  it('gives the folder a menu: rename, edit the brief, add an agent, delete after confirming', async () => {
    state.agents = [agent('a1', 'Pepe', 's1'), agent('a3', 'Luis')];
    state.spaces = [space({ memberAgentIds: ['a1'] })];
    await mount();
    let menu!: ReactTestRenderer;
    await act(async () => {
      menu = create(spacesSection().folders[0].actions);
    });
    await act(async () => menuItem(menu.root, 'spaces.rename').props.onPress());
    expect(dialogTitled('spaces.renameTitle')).toHaveLength(1);
    await act(async () => menuItem(menu.root, 'spaces.editBrief').props.onPress());
    expect(dialogTitled('spaces.briefTitle')).toHaveLength(1);
    await act(async () => menuItem(menu.root, 'spaces.addAgent').props.onPress());
    expect(dialogTitled('spaces.addAgentsTitle')).toHaveLength(1);
    await act(async () => menuItem(menu.root, 'spaces.delete').props.onPress());
    await settle();
    expect(state.mutations.deleteSpace.mutateAsync).toHaveBeenCalledWith('s1');
  });
});
