import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the app composes around the SDK's conversation: the one screen behind `/`, `/c/:id` and
 * `/@agent`. The conversation itself (its thread, composer and call) is the SDK's and pinned
 * there; here is only what the app decides — which power level a turn is sent with, what the
 * person's own devices add to the selector, the breadcrumb and its actions, the project crumb, the
 * sign-in a signed-out send asks for, and the dialog for a usage limit.
 */

const world = vi.hoisted(() => ({
  props: null as null | Record<string, any>,
  globalLevel: 'high',
  setGlobalLevel: vi.fn(),
  ghostMode: false,
  authenticated: true,
  signIn: vi.fn(() => Promise.resolve()),
  title: undefined as string | undefined,
  devices: [] as { id: string; name: string; deviceLabel: string }[],
  deviceIdsLoading: false,
  projects: [] as { name: string; conversationIds: string[] }[],
  folders: [] as { name: string; conversationIds: string[] }[],
  setChatId: vi.fn(),
  setGhostMode: vi.fn(),
}));

vi.mock('@alia.onl/sdk', async () => {
  const ReactModule = await import('react');
  return {
    AliaChatContent: (props: Record<string, unknown>) => {
      world.props = props;
      return ReactModule.createElement('AliaChatContent', null);
    },
    AliaParticipantsHeader: (props: object) =>
      ReactModule.createElement('ParticipantsHeader', props),
  };
});
vi.mock('@alia.onl/sdk/model', () => ({
  // The real rule, kept small: a level is sent as itself, a connected device model too.
  resolveModeSelection: (stored: string | null | undefined, ids: string[] | undefined) => {
    const ok =
      typeof stored === 'string' &&
      (!stored.startsWith('local/') || ids?.includes(stored) !== false);
    return { shown: ok ? stored : 'auto', send: ok ? stored : 'auto', source: 'requested' };
  },
}));
vi.mock('@alia.onl/sdk/runtime', () => ({
  useConversation: () => ({ data: world.title === undefined ? undefined : { title: world.title } }),
}));
vi.mock('@oxy.so/services', () => ({
  useAuth: () => ({ isAuthenticated: world.authenticated, signIn: world.signIn }),
}));
vi.mock('@oxy.so/bloom/composer-panel', () => ({
  ComposerPanelStatusTab: (props: object) => React.createElement('StatusTab', props),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('@/features/billing/ui/usage-limit-dialog', () => ({
  UsageLimitDialog: (props: object) => React.createElement('UsageLimitDialog', props),
}));
vi.mock('@/features/chat/runtime/global-store', () => {
  const state = {
    get ghostMode() {
      return world.ghostMode;
    },
    setChatId: world.setChatId,
    setGhostMode: world.setGhostMode,
  };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), {
    getState: () => state,
  });
  return { useStore };
});
vi.mock('@/features/chat/runtime/model-store', () => ({
  useModelStore: (select: (s: Record<string, unknown>) => unknown) =>
    select({ selectedLevel: world.globalLevel, setSelectedLevel: world.setGlobalLevel }),
}));
vi.mock('@/features/chat/runtime/use-app-voice-options', () => ({
  useAppVoiceOptions: () => ({ canStartVoice: () => null }),
}));
vi.mock('@/features/chat/runtime/use-credit-warnings', () => ({ useCreditWarnings: () => {} }));
vi.mock('@/features/chat/runtime/use-local-models-invite', () => ({
  useLocalModelsInvite: () => {},
}));
vi.mock('@/features/chat/runtime/use-suggestions', () => ({
  useWelcomeSuggestions: () => ({
    data: [{ suggestionId: 's1', text: 'Plan my week', isTemplate: false }],
  }),
  useSearchSuggestions: () => ({
    data: [{ suggestionId: 's2', text: 'Write to [name]', isTemplate: true }],
  }),
  useRecordSuggestionUsage: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/features/chat/ui/chat-workspace', async () => {
  const ReactModule = await import('react');
  return {
    KeyboardFrame: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement('KeyboardFrame', null, children),
  };
});
vi.mock('@/features/chat/ui/composer/use-alia-composer', () => ({
  useComposerMenu: (options: object) => ({ groups: [], onSelect: () => {}, options }),
}));
vi.mock('@/features/chat/ui/composer/power-level-options', () => ({
  useModeSelection: (stored: string) => ({ shown: stored, send: stored, source: 'requested' }),
}));
vi.mock('@/features/chat/ui/conversation-actions', () => ({
  ConversationActions: (props: object) => React.createElement('ConversationActions', props),
}));
vi.mock('@/features/local-models/runtime/use-local-runtimes', () => ({
  useLocalModelOptions: () => ({
    options: world.devices,
    ids: world.devices.map((d) => d.id),
    loading: world.deviceIdsLoading,
  }),
}));
vi.mock('@/features/projects/runtime/projects-store', () => ({
  useProjectsStore: (select: (s: { projects: unknown[] }) => unknown) =>
    select({ projects: world.projects }),
}));
vi.mock('@/features/projects/runtime/folders-store', () => ({
  useFoldersStore: (select: (s: { folders: unknown[] }) => unknown) =>
    select({ folders: world.folders }),
}));
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'en' }),
}));
vi.mock('@/shared/platform/useColorScheme', () => ({
  useColorScheme: () => ({ isDarkColorScheme: true }),
}));
vi.mock('@/shared/platform/use-screen-on-show', () => ({ useScreenOnShow: () => true }));

import { ConversationScreen } from '@/features/chat/ui/conversation-screen';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: ReactTestRenderer | undefined;
function mount(props: React.ComponentProps<typeof ConversationScreen> = {}) {
  act(() => {
    renderer = create(<ConversationScreen {...props} />);
  });
  return (renderer as unknown as ReactTestRenderer).root;
}
const content = () => world.props as Record<string, any>;

beforeEach(() => {
  world.props = null;
  world.globalLevel = 'high';
  world.ghostMode = false;
  world.authenticated = true;
  world.title = undefined;
  world.devices = [];
  world.deviceIdsLoading = false;
  world.projects = [];
  world.folders = [];
  world.setGlobalLevel.mockClear();
  world.setChatId.mockClear();
  world.setGhostMode.mockClear();
  world.signIn.mockClear();
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('the conversation the screen names', () => {
  it('passes the conversation, its agent and its thread to the SDK screen as they are', () => {
    mount({ conversationId: 'c1', agentId: 'a1', threadHandle: 'pepe' });
    expect(content()).toMatchObject({
      conversationId: 'c1',
      agent: { id: 'a1' },
      threadHandle: 'pepe',
    });
  });

  it('names none on the new-chat screen, which is what makes its first turn create one', () => {
    mount();
    expect(content().conversationId).toBeUndefined();
  });

  it('lights its row in the sidebar, and none on the new-chat screen', () => {
    mount({ conversationId: 'c1' });
    expect(world.setChatId).toHaveBeenLastCalledWith({ id: 'c1', from: 'url' });
    mount();
    expect(world.setChatId).toHaveBeenLastCalledWith(null);
  });

  it('starts every chat saved: ghost mode is a choice for the conversation about to begin', () => {
    mount();
    expect(world.setGhostMode).toHaveBeenCalledWith(false);
  });

  it('stores nothing while ghost mode is on', () => {
    world.ghostMode = true;
    mount();
    expect(content().ephemeral).toBe(true);
  });
});

describe('the power level', () => {
  it('is the person’s standing choice, and choosing changes it, on the new-chat screen', () => {
    mount();
    expect(content().model).toBe('high');
    content().onModelChange('ultra');
    expect(world.setGlobalLevel).toHaveBeenCalledWith('ultra');
  });

  it('is kept by the conversation once chosen there, and leaves the standing choice alone', () => {
    mount({ conversationId: 'c1' });
    expect(content().model).toBe('high');

    act(() => content().onModelChange('pro'));

    expect(content().model).toBe('pro');
    expect(world.setGlobalLevel).not.toHaveBeenCalled();
  });

  it('offers the person’s own devices after the levels', () => {
    world.devices = [{ id: 'local/ollama/llama3', name: 'llama3', deviceLabel: 'Laptop' }];
    mount();
    expect(content().deviceModels).toEqual(world.devices);
  });
});

describe('the breadcrumb', () => {
  it('draws the conversation’s own title, then the agent’s name, then "new chat"', () => {
    world.title = 'Trip to Lugo';
    mount({ conversationId: 'c1', agentName: 'Atlas' });
    expect(content().chrome({}).title).toBe('Trip to Lugo');

    world.title = undefined;
    mount({ conversationId: 'c1', agentName: 'Atlas' });
    expect(content().chrome({}).title).toBe('Atlas');

    mount({ conversationId: 'c1' });
    expect(content().chrome({}).title).toBe('chat.newChat');
  });

  it('puts the SDK’s participants in the header, and draws no title of its own there', () => {
    mount({ conversationId: 'c1', agentName: 'Atlas' });
    const participants = { lead: { id: 'a1', name: 'Atlas' }, joined: [] };
    const header = content().chrome({ participants }).header as React.ReactElement<
      Record<string, unknown>
    >;
    expect(header.props).toEqual({ participants });
  });

  it('files a chat under the project that holds it, else its folder, else the tree', () => {
    world.projects = [{ name: 'Trips', conversationIds: ['c1'] }];
    mount({ conversationId: 'c1' });
    expect(content().chrome({}).project).toBe('Trips');

    world.projects = [];
    world.folders = [{ name: 'Inbox', conversationIds: ['c1'] }];
    mount({ conversationId: 'c1' });
    expect(content().chrome({}).project).toBe('Inbox');

    world.folders = [];
    mount({ conversationId: 'c1' });
    expect(content().chrome({}).project).toBe('sidebar.chats');
  });

  it('files the new-chat screen under nothing, and offers it no actions: nothing is stored yet', () => {
    mount();
    expect(content().chrome({}).project).toBeUndefined();
    expect(content().chrome({}).actions).toBeUndefined();
    expect(content().composerStatus).toBeUndefined();
  });

  it('wires the actions to what the chat tells it, once there is a conversation', () => {
    mount({ conversationId: 'c1', agentId: 'a1', agentName: 'Atlas', threadHandle: 'pepe' });
    const chat = { conversationId: 'c1' };
    const actions = content().chrome(chat).actions as React.ReactElement<Record<string, unknown>>;
    expect(actions.props).toMatchObject({
      chat,
      agentName: 'Atlas',
      agentId: 'a1',
      threadHandle: 'pepe',
    });
  });
});

describe('what the account decides', () => {
  it('sends the signed-out to sign in, and leaves the signed-in to send', () => {
    world.authenticated = false;
    mount();
    content().onSignInRequired();
    expect(world.signIn).toHaveBeenCalledTimes(1);

    world.authenticated = true;
    mount();
    expect(content().onSignInRequired).toBeUndefined();
  });

  it('shows the usage limit as the app’s dialog, with the SDK’s way to dismiss it', () => {
    mount();
    const dismiss = vi.fn();
    const dialog = content().renderUsageLimit({
      error: new Error('limit'),
      dismiss,
    }) as React.ReactElement<{ onDismiss: () => void }>;
    expect(dialog.props.onDismiss).toBe(dismiss);
  });

  it('hands the SDK the plan gate of the call, and the suggestions in its own words', () => {
    mount();
    expect(content().voice.canStartVoice()).toBeNull();
    expect(content().welcomeSuggestions).toEqual([
      { id: 's1', text: 'Plan my week', template: false },
    ]);
    expect(content().suggestionMatches).toEqual([
      { id: 's2', text: 'Write to [name]', template: true },
    ]);
  });
});

describe('the frame', () => {
  it('stands the chat on the screen’s surface, in the safe area, running only while on show', () => {
    mount();
    expect(content()).toMatchObject({
      surface: true,
      bottomInset: 34,
      isFocused: true,
      isDarkMode: true,
    });
  });
});
