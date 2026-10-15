import type React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The conversation's own actions, wired to the app: what an export is called and says, when a
 * delete is confirmed and where it goes, and which agent's terminal the chat can show. The menu
 * that draws them is pinned in `chat-surfaces.test.tsx`; the chat they act on is the SDK's.
 */

const world = vi.hoisted(() => ({
  delivered: [] as [string, string, string][],
  deliverFails: false,
  confirmed: true,
  deleted: [] as string[],
  deleteFails: false,
  replaced: [] as string[],
  toastErrors: [] as string[],
  cachedTitle: undefined as string | undefined,
  ui: {
    activeAgentConversationId: null as string | null,
    activeAgentId: null as string | null,
    openAgentTerminal: vi.fn(),
  },
  menu: null as null | Record<string, any>,
}));

vi.mock('@alia.onl/sdk/model', () => ({
  buildConversationMarkdown: (input: { title: string; assistantName?: string }) =>
    `# ${input.title} (${input.assistantName ?? 'Alia'})`,
  exportFilename: (title: string) => `${title}.md`,
}));
vi.mock('@alia.onl/sdk/runtime', () => ({
  useDeleteConversation: () => ({
    mutateAsync: async (id: string) => {
      if (world.deleteFails) throw new Error('refused');
      world.deleted.push(id);
    },
  }),
}));
vi.mock('@oxy.so/bloom/surfaces', () => ({ confirm: async () => world.confirmed }));
vi.mock('@oxy.so/bloom/toast', () => ({
  toast: { error: (message: string) => world.toastErrors.push(message) },
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ getQueryData: () => world.cachedTitle && { title: world.cachedTitle } }),
}));
vi.mock('expo-router', () => ({
  usePathname: () => '/c/c1',
  useRouter: () => ({ replace: (path: string) => world.replaced.push(path) }),
}));
vi.mock('@/features/chat/runtime/conversation-share', () => ({
  deliverMarkdownFile: async (...args: [string, string, string]) => {
    if (world.deliverFails) throw new Error('no share');
    world.delivered.push(args);
  },
}));
vi.mock('@/features/chat/runtime/ui-store', () => ({
  useUIStore: Object.assign((select: (s: typeof world.ui) => unknown) => select(world.ui), {
    getState: () => world.ui,
  }),
}));
vi.mock('@/features/chat/ui/chat-header-actions', () => ({
  ChatHeaderActions: (props: Record<string, any>) => {
    world.menu = props;
    return null;
  },
}));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'en' }),
}));

import { ConversationActions } from '@/features/chat/ui/conversation-actions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const chat = (over: Record<string, unknown> = {}) =>
  ({
    conversationId: 'c1',
    hasMessages: true,
    startOver: vi.fn(),
    clearMessages: vi.fn(async () => true),
    markState: 'idle',
    agents: [],
    openSearch: undefined,
    getMessages: () => [{ id: 'm1', role: 'user', content: 'hi' }],
    ...over,
  }) as never;

let renderer: ReactTestRenderer | undefined;
function mount(props: Partial<React.ComponentProps<typeof ConversationActions>> = {}) {
  act(() => {
    renderer = create(<ConversationActions chat={chat()} {...props} />);
  });
  return world.menu as Record<string, any>;
}

beforeEach(() => {
  world.delivered = [];
  world.deliverFails = false;
  world.confirmed = true;
  world.deleted = [];
  world.deleteFails = false;
  world.replaced = [];
  world.toastErrors = [];
  world.cachedTitle = undefined;
  world.ui.activeAgentConversationId = null;
  world.ui.activeAgentId = null;
  world.ui.openAgentTerminal.mockClear();
  world.menu = null;
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('exporting the conversation', () => {
  it('names the document after the generated title the cache already holds', async () => {
    world.cachedTitle = 'Trip to Lugo';
    const menu = mount({ agentName: 'Atlas' });
    await act(async () => menu.onExport());
    expect(world.delivered).toEqual([
      ['Trip to Lugo.md', '# Trip to Lugo (Atlas)', 'Trip to Lugo'],
    ]);
  });

  it('falls back to the agent’s name, then to "new chat"', async () => {
    const named = mount({ agentName: 'Atlas' });
    await act(async () => named.onExport());
    expect(world.delivered.at(-1)?.[0]).toBe('Atlas.md');

    const unnamed = mount();
    await act(async () => unnamed.onExport());
    expect(world.delivered.at(-1)?.[0]).toBe('chat.newChat.md');
  });

  it('says so when it could not be delivered', async () => {
    world.deliverFails = true;
    const menu = mount();
    await act(async () => menu.onExport());
    expect(world.toastErrors).toEqual(['chat.exportFailed']);
  });
});

describe('deleting the conversation', () => {
  it('asks first, deletes, and goes home', async () => {
    const menu = mount();
    await act(async () => menu.onDelete());
    expect(world.deleted).toEqual(['c1']);
    expect(world.replaced).toEqual(['/']);
  });

  it('deletes nothing and goes nowhere when the person says no', async () => {
    world.confirmed = false;
    const menu = mount();
    await act(async () => menu.onDelete());
    expect(world.deleted).toEqual([]);
    expect(world.replaced).toEqual([]);
  });

  it('stays where it is when the server refuses (the mutation tells why)', async () => {
    world.deleteFails = true;
    const menu = mount();
    await act(async () => menu.onDelete());
    expect(world.replaced).toEqual([]);
  });

  it('is not offered on an agent’s thread: it is a view over several conversations', () => {
    expect(mount({ threadHandle: 'pepe' }).onDelete).toBeUndefined();
  });
});

describe('the rest of the menu', () => {
  it('searches only a thread, and clears through the chat', () => {
    const menu = mount();
    expect(menu.onSearch).toBeUndefined();
    const openSearch = vi.fn();
    const clearMessages = vi.fn();
    const withSearch = mount({ chat: chat({ openSearch, clearMessages }) });
    expect(withSearch.onSearch).toBe(openSearch);
    expect(withSearch.onClear).toBe(clearMessages);
  });

  it('shows the terminal of the thread’s own agent', () => {
    const menu = mount({ agentId: 'a1' });
    act(() => menu.onOpenTerminal());
    expect(world.ui.openAgentTerminal).toHaveBeenCalledWith('a1', '/c/c1');
  });

  it('shows the terminal of the agent a turn of THIS conversation put to work', () => {
    world.ui.activeAgentConversationId = 'c1';
    world.ui.activeAgentId = 'a9';
    const menu = mount();
    act(() => menu.onOpenTerminal());
    expect(world.ui.openAgentTerminal).toHaveBeenCalledWith('a9', '/c/c1');
  });

  it('offers no terminal when the agent at work belongs to another chat', () => {
    world.ui.activeAgentConversationId = 'other';
    world.ui.activeAgentId = 'a9';
    expect(mount().onOpenTerminal).toBeUndefined();
  });
});
