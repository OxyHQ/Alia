import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a turn in the thread can do, pressed on the real Bloom turns (#608 §7).
 *
 * Bloom's `AiChatAssistantMessage` / `AiChatUserMessage` and their feedback and
 * action rows are mounted for real — only the thread's scroll view is a host —
 * and the presses go through `useChatConversation`, with nothing below it but
 * the streaming hook's `append`. So "regenerate" is asserted by WHICH prompt
 * reached `append` with WHICH options, an edit by the draft it leaves in the
 * composer and the turn it sends, copy by what Bloom's own button then shows,
 * and read aloud by the toggle it draws.
 */

const platform = vi.hoisted(() => ({ OS: 'web' as 'web' | 'ios' }));
vi.mock('react-native', async () => (await import('./native-module-stubs')).reactNativeModule(platform));
vi.mock('react-native-reanimated', async () => (await import('./native-module-stubs')).reanimatedModule());
vi.mock('react-native-svg', async () => (await import('./native-module-stubs')).svgModule());
vi.mock('react-native-gesture-handler', async () => (await import('./native-module-stubs')).gestureHandlerModule());
vi.mock('react-native-screens', async () => (await import('./native-module-stubs')).screensModule());
vi.mock('react-native-safe-area-context', async () => (await import('./native-module-stubs')).safeAreaModule());
// Bloom's sheet (the long-press menu on a phone) sits on a blur.
vi.mock('expo-blur', async () => (await import('./native-module-stubs')).blurModule());

/** The thread's scroll view is the one Bloom piece not under test here. */
vi.mock('@oxy.so/bloom/ai-chat', async (importOriginal) => {
  const ReactModule = await import('react');
  const original = await importOriginal<Record<string, unknown>>();
  const AiChatThread = ReactModule.forwardRef(function AiChatThread(
    { children }: React.PropsWithChildren,
    _ref: React.Ref<unknown>,
  ) {
    return ReactModule.createElement('Thread', null, children);
  });
  return { ...original, AiChatThread, useAiChatChromeInsets: () => null };
});

// ---- the audio: TTS and dictation, as shared stores like the SDK's ----------
const audio = vi.hoisted(() => ({
  activeMessageId: null as string | null,
  playbackState: 'idle' as string,
  isRecording: false,
  listeners: new Set<() => void>(),
  readAloud: [] as unknown[][],
  stops: 0,
  set(change: Partial<{ activeMessageId: string | null; playbackState: string; isRecording: boolean }>) {
    Object.assign(audio, change);
    for (const listener of audio.listeners) listener();
  },
}));
function useAudio<T>(select: () => T): T {
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    audio.listeners.add(force);
    return () => {
      audio.listeners.delete(force);
    };
  }, []);
  return select();
}
vi.mock('@/lib/hooks/use-tts', () => ({
  useTTS: () => {
    const activeMessageId = useAudio(() => audio.activeMessageId);
    const playbackState = useAudio(() => audio.playbackState);
    return {
      activeMessageId,
      playbackState,
      readAloud: async (...args: unknown[]) => {
        audio.readAloud.push(args);
        audio.set({ activeMessageId: args[0] as string, playbackState: 'playing' });
      },
      stop: () => {
        audio.stops += 1;
        audio.set({ activeMessageId: null, playbackState: 'idle' });
      },
    };
  },
}));

vi.mock('@alia.onl/sdk', async () => ({
  useSTTStore: (select: (s: { isRecording: boolean }) => unknown) =>
    useAudio(() => select({ isRecording: audio.isRecording })),
  getTextFromContent: (content: unknown) =>
    typeof content === 'string'
      ? content
      : (content as { type: string; text?: string }[])
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join(''),
  getImagesFromContent: () => [],
  IdentityMark: () => null,
  PlanPreviewCard: () => null,
}));

// ---- the clipboard and the toasts --------------------------------------------
const clipboard = vi.hoisted(() => ({
  result: true as boolean | Error,
  written: [] as string[],
}));
vi.mock('expo-clipboard', () => ({
  setStringAsync: async (text: string) => {
    clipboard.written.push(text);
    if (clipboard.result instanceof Error) throw clipboard.result;
    return clipboard.result;
  },
}));
const toasts = vi.hoisted(() => ({ success: [] as string[], error: [] as string[] }));
vi.mock('@oxy.so/bloom/toast', () => ({
  toast: {
    success: (m: string) => toasts.success.push(m),
    error: (m: string) => toasts.error.push(m),
    info: () => {},
  },
}));

// ---- everything else the thread draws, which these presses do not reach ------
const stub = vi.hoisted(() => (name: string) => async () => {
  const ReactModule = await import('react');
  return ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    ReactModule.createElement(name, props, children);
});
vi.mock('@/components/ui/markdown', async () => ({ CustomMarkdown: await stub('Markdown')() }));
vi.mock('@/components/agent-result-card', async () => ({ AgentResultCard: await stub('AgentResultCard')() }));
vi.mock('@/components/agent-task-card', async () => ({ AgentTaskCard: await stub('AgentTaskCard')() }));
vi.mock('@/components/welcome-message', async () => ({ WelcomeMessage: await stub('Welcome')() }));
vi.mock('@/components/chat/failed-turn-card', async () => ({ FailedTurnCard: await stub('FailedTurnCard')() }));
vi.mock('@/components/chat/message-block-boundary', async () => ({ MessageBlockBoundary: await stub('Boundary')() }));
vi.mock('@/components/chat/tool-result-card', async () => ({ ToolResultCard: await stub('ToolCard')() }));
vi.mock('@/components/chat/turn-status-line', async () => ({ TurnStatusLine: await stub('StatusLine')() }));
vi.mock('@/components/new-conversation-offer', async () => ({ NewConversationOffer: await stub('Offer')() }));
vi.mock('@/components/ui/image', async () => ({ Image: await stub('Image')() }));
vi.mock('@oxy.so/bloom/agent-progress', async () => ({ AgentProgress: await stub('AgentProgress')() }));
vi.mock('@oxy.so/bloom/chat-screen', async () => ({ ChatDateHeader: await stub('DayHeader')() }));
vi.mock('@oxy.so/bloom/divider', async () => ({ Divider: await stub('Divider')() }));
vi.mock('@oxy.so/bloom/task-list', async () => ({ TaskList: await stub('TaskList')() }));
vi.mock('@oxy.so/bloom/web-search', async () => ({ WebSearch: await stub('WebSearch')() }));
vi.mock('@oxy.so/bloom/agent-thinking', async () => ({ AgentThinking: await stub('Thinking')() }));
vi.mock('@oxy.so/bloom/loading', async () => ({ Loading: await stub('Loading')() }));
vi.mock('@oxy.so/bloom/skeleton', async () => ({ Box: await stub('Skeleton')() }));
vi.mock('@/lib/chat/work-log', () => ({
  isWebInvocation: () => false,
  taskListLog: () => ({ tasks: [], revealed: 0 }),
  webSearchLog: () => null,
}));
vi.mock('@/lib/task-utils', () => ({ getToolPillLabel: (name: string) => name }));
vi.mock('@/lib/agents/agent-color', () => ({ agentTint: () => '#000' }));
const votes = vi.hoisted(() => ({ sent: [] as [string, unknown][], fail: false }));
vi.mock('@/lib/api/client', () => ({
  default: {
    patch: async (url: string, body: unknown) => {
      votes.sent.push([url, body]);
      if (votes.fail) throw new Error('refused');
      return {};
    },
  },
}));
vi.mock('@/lib/useColorScheme', () => ({ useColorScheme: () => ({ colors: {} }) }));
const translation = vi.hoisted(() => ({ t: (key: string) => key, locale: 'en-GB' }));
vi.mock('@/lib/hooks/use-translation', () => ({ useTranslation: () => translation }));
vi.mock('@/lib/stores/ui-store', () => {
  const ui = { rightPanel: null, syncThoughtScope: () => {}, openThoughtPanel: () => {} };
  const useUIStore = (select: (state: typeof ui) => unknown) => select(ui);
  useUIStore.getState = () => ui;
  return { useUIStore };
});

// ---- below useChatConversation: the streaming hook's `append`, and no more ---
const chat = vi.hoisted(() => ({
  messages: [] as { id: string; role: string; content: unknown }[],
  appended: [] as { message: { role: string; content: unknown }; options: unknown }[],
  setTo: null as unknown,
  turnOptions: {} as Record<string, unknown>,
}));
vi.mock('@/lib/hooks/use-streaming-chat', () => ({
  useStreamingChat: () => ({
    messages: chat.messages,
    append: async (message: { role: string; content: unknown }, options?: unknown) => {
      chat.appended.push({ message, options });
      return 'sent';
    },
    isLoading: false,
    error: null,
    clearError: () => {},
    setMessages: (next: unknown) => {
      chat.setTo = typeof next === 'function' ? (next as (p: unknown) => unknown)(chat.messages) : next;
    },
    stop: () => {},
    approvePlan: () => {},
    rejectPlan: () => {},
    suggestedNewConversation: null,
    dismissSuggestedNewConversation: () => {},
    failedTurn: null,
    retryFailedTurn: async () => 'sent',
    clearFailedTurn: () => {},
    turnOptionsOf: (id: string) => chat.turnOptions[id],
  }),
}));
vi.mock('@/lib/stores/global-store', () => {
  const state = {
    chatId: { id: 'c1', from: 'url' },
    pendingInitialMessage: null,
    setStreamingChatId: () => {},
    streamingChatId: null,
    setChatId: () => {},
    setBottomChatHeightHandler: () => {},
    clearPendingInitialMessage: () => {},
    setPendingInitialMessage: () => {},
  };
  const useStore = Object.assign((select: (s: typeof state) => unknown) => select(state), {
    getState: () => state,
  });
  return { useStore };
});
vi.mock('expo-router', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
vi.mock('@/lib/hooks/use-conversations', () => ({
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  useConversation: () => ({ data: undefined, isLoading: false, isFetching: false }),
  useCreateConversation: () => ({ mutateAsync: async () => ({}) }),
  useDeleteConversation: () => ({ mutateAsync: async () => {} }),
  useClearConversation: () => ({ mutateAsync: async () => {} }),
}));
vi.mock('@/lib/attachment-utils', () => ({
  buildMessageContent: async (text: string) => ({ content: text, dropped: [] }),
}));
vi.mock('@/lib/generate-api-url', () => ({ generateAPIUrl: () => 'http://test.invalid/chat' }));
vi.mock('@/lib/i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('@/lib/api/notifications-socket', () => ({
  acquireNotificationsSocket: () => ({ socket: { on: () => {}, off: () => {} }, release: () => {} }),
}));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { BloomThemeProvider } = await import('@oxy.so/bloom/theme');
const { ChatInterface } = await import('@/components/chat-interface');
const { useChatConversation } = await import('@/lib/hooks/use-chat-conversation');
const { useTurnEdit } = await import('@/lib/chat/use-turn-edit');
const { useComposerDraftStore } = await import('@/lib/stores/composer-draft-store');
const { timelinePositions } = await import('@/lib/chat/timeline');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const THREAD = [
  { id: 'u1', role: 'user', content: 'first question' },
  { id: 'a1', role: 'assistant', content: 'first answer' },
  { id: 'u2', role: 'user', content: 'second question' },
  { id: 'a2', role: 'assistant', content: 'second answer' },
];

const harness = vi.hoisted(() => ({
  edit: null as null | ReturnType<typeof import('@/lib/chat/use-turn-edit').useTurnEdit>,
}));

function Harness({ callActive = false }: { callActive?: boolean }) {
  const api = useChatConversation({ conversationId: 'c1' });
  const edit = useTurnEdit({
    target: 'c1',
    messages: api.messages,
    turnOptionsOf: api.turnOptionsOf,
    onEditMessage: api.editMessage,
  });
  harness.edit = edit;
  return (
    <ChatInterface
      threadRef={{ current: null }}
      messages={api.messages}
      activeConversationId="c1"
      onRegenerate={(id) => void api.regenerateMessage(id, { mcpServerId: null, skillNames: [] })}
      onStartEdit={edit.start}
      callActive={callActive}
    />
  );
}

let renderer: ReactTestRenderer | null = null;
async function mount(props: { callActive?: boolean } = {}): Promise<ReactTestRenderer> {
  const client = new QueryClient();
  await act(async () => {
    renderer = create(
      <BloomThemeProvider mode="light">
        <QueryClientProvider client={client}>
          <Harness {...props} />
        </QueryClientProvider>
      </BloomThemeProvider>,
    );
  });
  return renderer as unknown as ReactTestRenderer;
}

beforeEach(() => {
  chat.messages = THREAD.map((m) => ({ ...m }));
  votes.sent = [];
  votes.fail = false;
  chat.appended = [];
  chat.setTo = null;
  chat.turnOptions = {};
  clipboard.result = true;
  clipboard.written = [];
  toasts.success = [];
  toasts.error = [];
  audio.activeMessageId = null;
  audio.playbackState = 'idle';
  audio.isRecording = false;
  audio.readAloud = [];
  audio.stops = 0;
  platform.OS = 'web';
  useComposerDraftStore.setState({ account: 'me', drafts: {} });
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  timelinePositions.clear();
});

/** A host element of the stubbed `react-native` (see `native-module-stubs.tsx`). */
const isHost = (node: ReactTestInstance, name: string) => (node.type as unknown) === name;

/** Bloom's action buttons, by the label it gives them. */
const buttons = (r: ReactTestRenderer, label: string): ReactTestInstance[] =>
  r.root.findAll(
    (node) => isHost(node, 'Pressable') && node.props.accessibilityLabel === label,
  );
/** Copy on the last reply: the questions' copy buttons come first in each pair. */
const replyCopy = (r: ReactTestRenderer) => buttons(r, 'chat.copy')[3];
async function press(button: ReactTestInstance) {
  await act(async () => {
    button.props.onPress?.();
  });
}

describe('a reply', () => {
  it('regenerates only the last one, replaying its question with the options it was sent with', async () => {
    chat.turnOptions = { u2: { mcpServerId: 'gmail', skillNames: ['digest'] } };
    const r = await mount();

    const regenerate = buttons(r, 'chat.regenerate');
    expect(regenerate).toHaveLength(1);
    await press(regenerate[0]);

    expect(chat.appended).toEqual([
      { message: { role: 'user', content: 'second question' }, options: { mcpServerId: 'gmail', skillNames: ['digest'] } },
    ]);
    // Cut back to before the question it replays.
    expect(chat.setTo).toEqual(THREAD.slice(0, 2));
  });

  it('offers no regenerate during a call', async () => {
    const r = await mount({ callActive: true });
    expect(buttons(r, 'chat.regenerate')).toHaveLength(0);
  });

  it('says "Copied" only after the clipboard took the text', async () => {
    const r = await mount();
    await press(replyCopy(r));

    expect(clipboard.written).toEqual(['second answer']);
    expect(toasts.success).toEqual(['chat.copiedToClipboard']);
    expect(r.root.findAll((node) => node.props.tooltip === 'chat.copied')).not.toHaveLength(0);
  });

  it('shows no "Copied" and an error when the clipboard refuses', async () => {
    clipboard.result = false;
    const r = await mount();
    await press(replyCopy(r));

    expect(toasts.error).toEqual(['chat.copyFailed']);
    expect(toasts.success).toEqual([]);
    expect(r.root.findAll((node) => node.props.tooltip === 'chat.copied')).toHaveLength(0);
  });

  it('shows no "Copied" and an error when the clipboard throws', async () => {
    clipboard.result = new Error('no clipboard');
    const r = await mount();
    await press(replyCopy(r));

    expect(toasts.error).toEqual(['chat.copyFailed']);
    expect(r.root.findAll((node) => node.props.tooltip === 'chat.copied')).toHaveLength(0);
  });

  it('reads aloud as a toggle: pressed while it plays, stopped by a second press', async () => {
    const r = await mount();
    await press(buttons(r, 'chat.readAloud')[1]);

    // Stored, so the clip is kept on the message for the next press.
    expect(audio.readAloud).toEqual([['a2', 'second answer', 'c1', undefined]]);
    const stopButton = buttons(r, 'chat.stopReading');
    expect(stopButton).toHaveLength(1);
    expect(stopButton[0].props.accessibilityState).toMatchObject({ selected: true });
    // The other reply is still an ordinary read-aloud.
    expect(buttons(r, 'chat.readAloud')).toHaveLength(1);

    await press(stopButton[0]);
    expect(audio.activeMessageId).toBeNull();
    expect(buttons(r, 'chat.stopReading')).toHaveLength(0);
    expect(buttons(r, 'chat.readAloud')).toHaveLength(2);
  });

  it('reads a reply the server does not hold yet without asking to store the clip on it', async () => {
    chat.messages[3] = { ...chat.messages[3], unsaved: true } as (typeof chat.messages)[number];
    const r = await mount();
    await press(buttons(r, 'chat.readAloud')[1]);

    // With the conversation id the route would look the message up, answer
    // 404, and nothing would be read.
    expect(audio.readAloud).toEqual([['a2', 'second answer', undefined, undefined]]);
  });

  it('votes on a stored reply by the id it is drawn under', async () => {
    const r = await mount();
    await press(buttons(r, 'chat.like')[1]);

    expect(votes.sent).toEqual([['/conversations/c1/messages/a2/vote', { vote: 'up' }]]);
    expect(toasts.success).toEqual(['chat.thanksFeedback']);
  });

  it('says so when a vote has nothing to land on, instead of thanking nobody', async () => {
    chat.messages[3] = { ...chat.messages[3], unsaved: true } as (typeof chat.messages)[number];
    const r = await mount();
    await press(buttons(r, 'chat.like')[1]);

    expect(votes.sent).toEqual([]);
    expect(toasts.error).toEqual(['chat.feedbackFailed']);
    expect(toasts.success).toEqual([]);
  });

  it('reports a vote the server refused', async () => {
    votes.fail = true;
    const r = await mount();
    await press(buttons(r, 'chat.dislike')[1]);

    expect(votes.sent).toHaveLength(1);
    expect(toasts.error).toEqual(['chat.feedbackFailed']);
    expect(toasts.success).toEqual([]);
  });

  it('stops reading when a dictation starts, and holds the button until it ends', async () => {
    const r = await mount();
    await press(buttons(r, 'chat.readAloud')[1]);
    expect(audio.playbackState).toBe('playing');

    await act(async () => audio.set({ isRecording: true }));

    expect(audio.activeMessageId).toBeNull();
    for (const button of buttons(r, 'chat.readAloud')) {
      expect(button.props.disabled).toBe(true);
    }
  });

  it('reports a read-aloud that failed and goes back to idle', async () => {
    const r = await mount();
    await press(buttons(r, 'chat.readAloud')[1]);
    await act(async () => audio.set({ playbackState: 'error' }));

    expect(toasts.error).toEqual(['chat.readAloudFailed']);
    expect(audio.activeMessageId).toBeNull();
    expect(buttons(r, 'chat.readAloud')).toHaveLength(2);
  });
});

describe('a question', () => {
  it('copies its words', async () => {
    const r = await mount();
    await press(buttons(r, 'chat.copy')[0]);
    expect(clipboard.written).toEqual(['first question']);
  });

  it('round-trips an edit: into the composer, cancelled, then sent in its place', async () => {
    chat.turnOptions = { u2: { mcpServerId: 'gmail', skillNames: ['digest'] } };
    const store = useComposerDraftStore.getState();
    store.setText(store.address('c1'), 'half a thought');
    const r = await mount();

    const edits = buttons(r, 'chat.edit');
    expect(edits).toHaveLength(2);
    await press(edits[1]);

    // The question's words and the options it was sent with, in this chat's composer.
    expect(useComposerDraftStore.getState().drafts.c1).toMatchObject({
      text: 'second question',
      mcpServerId: 'gmail',
      skillNames: ['digest'],
      editing: { messageId: 'u2' },
    });
    expect(harness.edit?.editing?.messageId).toBe('u2');

    // Cancel gives back what the composer held.
    await act(async () => harness.edit?.cancel());
    expect(useComposerDraftStore.getState().drafts.c1).toMatchObject({ text: 'half a thought' });
    expect(useComposerDraftStore.getState().drafts.c1?.editing).toBeUndefined();

    // Again, and sent: the rewrite replaces the question and what followed it.
    await press(buttons(r, 'chat.edit')[1]);
    let sent: boolean | undefined;
    await act(async () => {
      sent = await harness.edit?.submit('a better second question', {
        mcpServerId: 'gmail',
        skillNames: ['digest'],
      });
    });

    expect(sent).toBe(true);
    expect(chat.setTo).toEqual(THREAD.slice(0, 2));
    expect(chat.appended).toEqual([
      {
        message: { role: 'user', content: 'a better second question' },
        options: { mcpServerId: 'gmail', skillNames: ['digest'] },
      },
    ]);
  });

  it('offers no edit during a call', async () => {
    const r = await mount({ callActive: true });
    expect(buttons(r, 'chat.edit')).toHaveLength(0);
  });
});

describe('on a phone', () => {
  it('opens the same actions from a long press on the turn', async () => {
    platform.OS = 'ios';
    const r = await mount();
    const triggers = r.root.findAll(
      (node) => isHost(node, 'Pressable') && typeof node.props.onLongPress === 'function',
    );
    // One per turn: two questions, two replies.
    expect(triggers).toHaveLength(4);
    // Across the column, so a question still measures half of it: the host
    // view around each trigger ends up stretched, not hugging its content.
    for (const trigger of triggers) {
      let wrapper = trigger.parent;
      while (wrapper !== null && !isHost(wrapper, 'View')) wrapper = wrapper.parent;
      const style = [wrapper?.props.style].flat(Infinity).filter(Boolean);
      expect(Object.assign({}, ...style).alignSelf).toBe('stretch');
    }

    await act(async () => triggers[3].props.onLongPress());
    const rows = r.root.findAll((node) => isHost(node, 'Pressable') && node.props.role === 'menuitem');
    const labels = rows.map((row) => row.props.accessibilityLabel);
    expect(labels).toEqual(['chat.readAloud', 'chat.copy', 'chat.regenerate', 'chat.like', 'chat.dislike']);

    await act(async () => rows[2].props.onPress());
    expect(chat.appended).toHaveLength(1);
  });
});
