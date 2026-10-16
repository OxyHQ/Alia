import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sheet and the app draw ONE thread.
 *
 * The bottom sheet (`AliaChatSheet`), the full screen (`AliaChatScreen`) and the Alia app are
 * frames around `AliaChatContent`, which draws the conversation with `AliaThread`. They differ in
 * what they put around it — a sheet has no chrome and a smaller field, the app has a breadcrumb,
 * its own add menu, a level selector and a thought panel — and in nothing about the turns. Two
 * things are pinned:
 *
 *  - Mounted as a sheet mounts it and as the app mounts it, over the same conversation, the real
 *    thread renders the very same rows (Bloom's turns, mounted for real; only the scroll view and
 *    the container are hosts).
 *  - There is nowhere else a thread is drawn: no surface imports Bloom's thread or its turns but
 *    the SDK's `AliaThread` and `ThreadRow`, so a thread cannot fork again unnoticed.
 */

const platform = vi.hoisted(() => ({ OS: 'web' as 'web' | 'ios' }));
vi.mock('react-native', async () =>
  (await import('../../support/native-module-stubs')).reactNativeModule(platform),
);
vi.mock('react-native-reanimated', async () =>
  (await import('../../support/native-module-stubs')).reanimatedModule(),
);
vi.mock('react-native-svg', async () =>
  (await import('../../support/native-module-stubs')).svgModule(),
);
vi.mock('react-native-gesture-handler', async () =>
  (await import('../../support/native-module-stubs')).gestureHandlerModule(),
);
vi.mock('react-native-screens', async () =>
  (await import('../../support/native-module-stubs')).screensModule(),
);
vi.mock('react-native-safe-area-context', async () =>
  (await import('../../support/native-module-stubs')).safeAreaModule(),
);
vi.mock('expo-blur', async () => (await import('../../support/native-module-stubs')).blurModule());

/** The container and the thread's scroll view are the Bloom pieces not under test here. */
vi.mock('@oxy.so/bloom/ai-chat', async (importOriginal) => {
  const ReactModule = await import('react');
  const original = await importOriginal<Record<string, unknown>>();
  const AiChatThread = ReactModule.forwardRef(function AiChatThread(
    { children }: React.PropsWithChildren,
    _ref: React.Ref<unknown>,
  ) {
    return ReactModule.createElement('Thread', null, children);
  });
  const AiChatContainer = ({
    background,
    children,
    composer,
    header,
  }: Record<string, React.ReactNode>) =>
    ReactModule.createElement('Container', null, background, header, children, composer);
  return { ...original, AiChatThread, AiChatContainer, useAiChatChromeInsets: () => null };
});
vi.mock('@oxy.so/bloom/avatar-flight', () => ({
  AvatarFlightLayer: () => null,
  centeredLanding: () => () => ({}),
  useAvatarFlights: () => ({
    launch: async () => false,
    anchor: () => undefined,
    isLanding: () => false,
    isLeaving: () => false,
  }),
}));
vi.mock('../../../src/runtime/oxy-files', () => ({
  useDocumentUpload: () => async () => 'file-1',
}));
vi.mock('@oxy.so/bloom/chat-screen', async () => {
  const ReactModule = await import('react');
  return {
    ScrollToBottomButton: () => null,
    ChatDateHeader: ({ label }: { label: string }) =>
      ReactModule.createElement('DayHeader', null, label),
  };
});

// ---- below the thread: nothing but a fake stream ----------------------------
const chat = vi.hoisted(() => ({
  messages: [] as Record<string, unknown>[],
}));
vi.mock('../../../src/runtime/use-conversation-stream', () => ({
  useConversationStream: () => ({
    messages: chat.messages,
    append: async () => 'sent',
    isLoading: false,
    error: null,
    clearError: () => {},
    setMessages: () => {},
    stop: () => {},
    suggestedNewConversation: null,
    dismissSuggestedNewConversation: () => {},
    agentRun: null,
    failedTurn: null,
    retryFailedTurn: async () => 'sent',
    clearFailedTurn: () => {},
    turnOptionsOf: () => undefined,
  }),
}));
vi.mock('../../../src/runtime/conversations', () => ({
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  useConversation: () => ({ data: undefined, isLoading: false, isFetching: false }),
  useCreateConversation: () => ({ mutateAsync: async () => ({}), mutate: () => {} }),
  useDeleteConversation: () => ({ mutateAsync: async () => {} }),
  useClearConversation: () => ({ mutateAsync: async () => {} }),
}));
vi.mock('../../../src/runtime/use-agent-activity', () => ({ useAgentActivity: () => ({}) }));
vi.mock('../../../src/runtime/attachment-utils', () => ({
  buildMessageContent: async (text: string) => ({ content: text, dropped: [] }),
}));
vi.mock('../../../src/runtime/api', () => ({ useAliaApi: () => ({ patch: async () => ({}) }) }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ user: { id: 'me' }, isAuthenticated: true }),
}));
vi.mock('@oxy.so/core', () => ({ getAccountDisplayName: () => 'Nate' }));

// ---- everything else the chat draws, which a thread does not read -----------
const stub = vi.hoisted(() => (name: string) => async () => {
  const ReactModule = await import('react');
  return ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
});
vi.mock('../../../src/components/AliaComposer', async () => ({
  AliaComposer: await stub('Composer')(),
}));
vi.mock('../../../src/components/AmbientField', async () => ({
  AmbientField: await stub('AmbientField')(),
}));
vi.mock('../../../src/components/AliaWelcomeMessage', async () => ({
  AliaWelcomeMessage: await stub('Welcome')(),
}));
vi.mock('../../../src/components/VoiceModeIcon', () => ({ VoiceModeIcon: () => null }));
vi.mock('../../../src/components/voice/AliaVoiceCall', () => ({ AliaVoiceCall: () => null }));
vi.mock('../../../src/components/thread/ThreadSearch', () => ({ ThreadSearch: () => null }));
vi.mock('../../../src/components/ReplyMarkdown', async () => ({
  ReplyMarkdown: await stub('Markdown')(),
}));
vi.mock('../../../src/components/PlanPreviewCard', () => ({ PlanPreviewCard: () => null }));
vi.mock('../../../src/components/QuestionCard', () => ({ AskedQuestions: () => null }));
vi.mock('../../../src/components/Image', async () => ({ Image: await stub('Image')() }));
vi.mock('../../../src/hooks/useTTS', () => ({
  useTTS: () => ({
    readAloud: async () => {},
    stop: () => {},
    playbackState: 'idle',
    ttsWaveAmplitude: 0,
    activeMessageId: null,
  }),
}));
vi.mock('../../../src/hooks/useDictation', () => ({
  useDictationStore: (select: (s: { isRecording: boolean }) => unknown) =>
    select({ isRecording: false }),
}));
vi.mock('../../../src/hooks/useAmbientWave', () => ({
  useAmbientWave: () => ({ waveAmplitude: 0, agentState: 'idle', intensity: 1 }),
}));
vi.mock('../../../src/hooks/useFocusWhenPresented', () => ({ useFocusWhenPresented: () => {} }));
vi.mock('../../../src/hooks/useImagePicker', () => ({
  useImagePicker: () => ({ pickImage: async () => [] }),
}));
vi.mock('../../../src/hooks/useSoundEffects', () => ({ useVoiceSoundEffects: () => {} }));
vi.mock('../../../src/hooks/useComposerSuggestions', () => ({
  useComposerSuggestions: () => ({ completions: [], selected: -1, onKeyPress: () => {} }),
  useSuggestionQuery: () => '',
}));
vi.mock('../../../src/lib/power-level-options', () => ({ buildPowerLevelOptions: () => [] }));
vi.mock('../../../src/lib/keyboard', () => ({ KeyboardSafeAreaFloor: () => null }));
vi.mock('../../../src/lib/image-data-url', () => ({ imageUriToDataUrl: async (u: string) => u }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }));
vi.mock('@oxy.so/bloom/toast', () => ({
  toast: { success: () => {}, error: () => {}, info: () => {}, warning: () => {} },
}));
vi.mock('@oxy.so/bloom/agent-thinking', async () => ({
  AgentThinking: await stub('Thinking')(),
}));
vi.mock('@oxy.so/bloom/loading', async () => ({ Loading: await stub('Loading')() }));
vi.mock('@oxy.so/bloom/skeleton', async () => ({ Box: await stub('Skeleton')() }));
vi.mock('@oxy.so/bloom/divider', async () => ({ Divider: await stub('Divider')() }));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { BloomThemeProvider } = await import('@oxy.so/bloom/theme');
const { AliaChatContent } = await import('../../../src/components/AliaChatContent');
const { useComposerDraftStore } = await import('../../../src/runtime/composer-draft-store');
const { timelinePositions } = await import('../../../src/runtime/model');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const THREAD = [
  { id: 'u1', role: 'user', content: 'first question', createdAt: '2026-03-01T09:00:00.000Z' },
  { id: 'a1', role: 'assistant', content: 'first answer', createdAt: '2026-03-01T09:00:05.000Z' },
  { id: 'u2', role: 'user', content: 'second question', createdAt: '2026-03-02T09:00:00.000Z' },
  { id: 'a2', role: 'assistant', content: 'second answer', createdAt: '2026-03-02T09:00:05.000Z' },
];

let renderer: ReactTestRenderer | null = null;
async function mount(props: React.ComponentProps<typeof AliaChatContent>) {
  await act(async () => {
    renderer = create(
      <BloomThemeProvider mode="light">
        <QueryClientProvider client={new QueryClient()}>
          <AliaChatContent conversationId="c1" {...props} />
        </QueryClientProvider>
      </BloomThemeProvider>,
    );
  });
  return renderer as unknown as ReactTestRenderer;
}
async function unmount() {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  timelinePositions.clear();
}

/** What the thread drew, whatever frame it is in. */
function threadOf(r: ReactTestRenderer): string {
  const find = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') return undefined;
    if (Array.isArray(node)) return node.map(find).find((found) => found !== undefined);
    const element = node as { type?: string; children?: unknown };
    return element.type === 'Thread' ? element : find(element.children);
  };
  const found = find(r.toJSON());
  if (found === undefined) throw new Error('the chat drew no thread');
  return JSON.stringify(found);
}

beforeEach(() => {
  chat.messages = THREAD.map((m) => ({ ...m }));
  platform.OS = 'web';
  useComposerDraftStore.setState({ account: 'me', drafts: {} });
});
afterEach(unmount);

describe('a sheet and the app, over the same conversation', () => {
  /** How the bottom sheet mounts the chat: no chrome of its own, a sheet's field, the host's inset. */
  const asSheet = {
    layout: 'sheet' as const,
    bottomInset: 34,
    isDarkMode: false,
    voice: false as const,
  };
  /** How the app mounts it: a surface, a breadcrumb, its own menu, a level, a thought panel. */
  const asApp = {
    surface: true,
    chrome: () => ({ title: 'A chat', project: 'Chats' }),
    addMenu: { groups: [], onSelect: () => {} },
    model: 'pro',
    onModelChange: () => {},
    isFocused: true,
    threadHandle: undefined,
    runtime: { showThought: () => true, openAutomation: () => {} },
  };

  it('render the very same turns', async () => {
    const sheet = threadOf(await mount(asSheet));
    await unmount();
    const app = threadOf(await mount(asApp));

    expect(sheet).toBe(app);
    // And they are Bloom's turns with the thread's day line, not an empty comparison.
    expect(app).toContain('first answer');
    expect(app).toContain('second question');
    expect(app).toContain('DayHeader');
  });

  it('give a reply the same actions, for the same replies', async () => {
    const actionsOf = (r: ReactTestRenderer) =>
      r.root
        .findAll((node) => (node.type as unknown) === 'Pressable')
        .map((node) => node.props.accessibilityLabel)
        .filter(Boolean);

    const sheet = actionsOf(await mount(asSheet));
    await unmount();
    const app = actionsOf(await mount(asApp));

    expect(sheet).toEqual(app);
    expect(sheet).toContain('Copy');
    expect(sheet).toContain('Regenerate');
    expect(sheet).toContain('Read Aloud');
  });

  it('differ only by what the frame chose to put around the thread', async () => {
    const sheet = await mount(asSheet);
    expect(sheet.root.findAllByType('AmbientField' as never)[0]?.props.layout).toBe('sheet');
    await unmount();
    const app = await mount(asApp);
    expect(app.root.findAllByType('AmbientField' as never)[0]?.props.layout).toBe('screen');
  });
});

describe('one place draws the thread', () => {
  const PACKAGES = join(__dirname, '../../../..');
  const THREAD_PIECES =
    /@oxy\.so\/bloom\/ai-chat['"][\s\S]*?(AiChatThread|AiChatAssistantMessage|AiChatUserMessage)|(AiChatThread|AiChatAssistantMessage|AiChatUserMessage)[\s\S]*?from '@oxy\.so\/bloom\/ai-chat'/;
  /** The only files that may import Bloom's thread and its turns. */
  const OWNERS = [
    'alia-chat/src/components/thread/AliaThread.tsx',
    'alia-chat/src/components/thread/ThreadRow.tsx',
  ];

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      if (name === 'node_modules' || name === '__tests__' || name === 'tests') return [];
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }
  const code = (file: string) =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it("is imported from Bloom by nobody but the SDK's thread and its row", () => {
    const importers = [
      ...sources(join(PACKAGES, 'alia-chat/src')),
      ...sources(join(PACKAGES, 'app/src')),
      ...sources(join(PACKAGES, 'app/app')),
    ]
      .filter((file) => {
        const text = code(file);
        return /import\s*\{[^}]*\b(AiChatThread|AiChatAssistantMessage|AiChatUserMessage)\b[^}]*\}\s*from\s*'@oxy\.so\/bloom\/ai-chat'/.test(
          text,
        );
      })
      .map((file) => file.slice(PACKAGES.length + 1));
    expect(importers.sort()).toEqual([...OWNERS].sort());
    // Positive control: the pattern above must be able to see an importer at all.
    expect(THREAD_PIECES.test("import { AiChatThread } from '@oxy.so/bloom/ai-chat'")).toBe(true);
  });

  it('draws the participants, and builds a join flight, nowhere but `AliaParticipants`', () => {
    const files = [
      ...sources(join(PACKAGES, 'alia-chat/src')),
      ...sources(join(PACKAGES, 'app/src')),
      ...sources(join(PACKAGES, 'app/app')),
    ];
    const owners = (pattern: RegExp) =>
      files
        .filter((file) => pattern.test(code(file)))
        .map((file) => file.slice(PACKAGES.length + 1));
    /** Bloom's `AgentProfile`, imported by name from its entry. */
    const PROFILE =
      /import\s*\{[^}]*\bAgentProfile\b[^}]*\}\s*from\s*'@oxy\.so\/bloom\/agent-reply'/;
    /** What a join flight is made of: Bloom's merge landing, or a flight out of a reply. */
    const JOIN =
      /\bcenteredLanding\b|\bmerge:\s*true\b|from:\s*ANCHORS\.reply\(|from:\s*[`'"]reply:/;
    const OWNER = ['alia-chat/src/components/AliaParticipants.tsx'];

    expect(owners(PROFILE)).toEqual(OWNER);
    expect(owners(JOIN)).toEqual(OWNER);
    // Positive controls: the patterns see an importer and a spec at all.
    expect(PROFILE.test("import { AgentProfile } from '@oxy.so/bloom/agent-reply'")).toBe(true);
    expect(JOIN.test('landing: centeredLanding(14), merge: true')).toBe(true);
    expect(JOIN.test('from: ANCHORS.reply(agent.id)')).toBe(true);
  });

  it.each([
    ['the bottom sheet', 'alia-chat/src/components/AliaChatSheet.tsx'],
    ['the full screen', 'alia-chat/src/components/AliaChatScreen.tsx'],
    ['the Alia app', 'app/src/features/chat/ui/conversation-screen.tsx'],
  ])('%s mounts the conversation and draws no turn of its own', (_name, file) => {
    const text = code(join(PACKAGES, file));
    expect(text).toMatch(/<AliaChatContent/);
    expect(text).not.toMatch(/<AliaThread|<ThreadRow|useConversationThread/);
  });
});
