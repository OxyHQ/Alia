import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the conversation stands on and speaks through, whoever mounts it: the ambient field behind
 * it, the composer or the call bar in front, the questions docked above the composer, the strip
 * of a question being rewritten, the closed composer of a usage limit.
 *
 * ## A call and dictation never record at the same time
 *
 * Both take the microphone — dictation records a clip for Kaana to transcribe, a call streams it to
 * Alia's realtime session — and there is one microphone. So the rule is structural rather than a
 * lock: dictation lives in the composer (`useDictation` inside `AliaComposer`), and a call REPLACES
 * the composer with the call bar. Starting a call therefore unmounts the composer, and an unmounted
 * `useDictation` cancels its recording, releases the microphone and clears the shared dictation
 * state (pinned in `useDictation.test.tsx`). During the call there is no composer and so no way to
 * start dictating; ending it brings the composer back.
 *
 * The things that draw (composer, thread, call bar, ambient field) are probes that record what they
 * were given; the real hooks run under them, over a fake stream.
 */

const world = vi.hoisted(() => ({
  messages: [] as Record<string, unknown>[],
  isLoading: false,
  error: null as Error | null,
  appended: [] as { message: { role: string; content: unknown }; options: unknown }[],
  clearError: vi.fn(),
  signedIn: true,
  /** The mic button the composer was given while no call is open. */
  startVoice: null as null | (() => void),
  composer: { mounts: 0, unmounts: 0, props: null as null | Record<string, any> },
  field: [] as Record<string, unknown>[],
  call: null as null | Record<string, unknown>,
}));

vi.mock('react-native', () => ({ View: 'View', Text: 'Text' }));
vi.mock('react-native-reanimated', () => ({}));
vi.mock('../../src/lib/flights', () => ({
  AliaFlightsProvider: ({ children }: { children: React.ReactNode }) => children,
  ANCHORS: {
    welcome: 'lead:welcome',
    profile: 'participants',
    reply: (id: string) => `reply:${id}`,
  },
  leadToProfile: () => 'lead:to-profile',
}));
vi.mock('../../src/lib/agent-character', () => ({ readAgentCharacter: (value: unknown) => value }));
vi.mock('../../src/lib/alia-character', () => ({ ALIA_AVATAR: { preset: 'alia' } }));
vi.mock('../../src/components/AliaParticipants', () => ({
  useParticipants: ({ lead }: { lead: unknown }) => ({ lead, joined: [] }),
}));
vi.mock('../../src/runtime/agents', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAgentProfile: () => ({ data: undefined, isLoading: false }),
  useAgentFeatures: () => ({ data: undefined, isLoading: false }),
}));
vi.mock('../../src/runtime/oxy-files', () => ({ useDocumentUpload: () => async () => 'file-1' }));
vi.mock('@oxy.so/bloom/icons/RiFileTextLine', () => ({ RiFileTextLine: () => null }));
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({
    user: world.signedIn ? { id: 'u1' } : null,
    isAuthenticated: world.signedIn,
  }),
}));
vi.mock('@oxy.so/core', () => ({ getAccountDisplayName: () => 'Nate' }));
vi.mock('@oxy.so/bloom/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@oxy.so/bloom/button', () => ({
  Button: (props: { onPress?: () => void; accessibilityLabel?: string }) => {
    if (props.accessibilityLabel === 'Start voice') world.startVoice = props.onPress ?? null;
    return React.createElement('Button', props);
  },
}));
vi.mock('@oxy.so/bloom/ai-chat', () => ({
  AiChatContainer: ({
    composer,
    background,
    children,
  }: {
    composer: React.ReactNode;
    background: React.ReactNode;
    children: React.ReactNode;
  }) => React.createElement('Container', null, background, children, composer),
}));
vi.mock('@oxy.so/bloom/avatar-flight', () => ({
  AvatarFlightLayer: () => null,
  useAvatarJoin: ({ arrivals }: { arrivals: Array<{ agent: unknown }> }) =>
    arrivals.map((arrival) => arrival.agent),
  useAvatarFlights: () => ({ launch: async () => {}, anchor: () => undefined }),
}));
vi.mock('@oxy.so/bloom/chat-screen', () => ({ ScrollToBottomButton: () => null }));
vi.mock('@oxy.so/bloom/typography', () => ({ Text: 'Text' }));
vi.mock('@oxy.so/bloom/icons/RiEditLine', () => ({ RiEditLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiImageLine', () => ({ RiImageLine: () => null }));
vi.mock('../../src/lib/keyboard', () => ({ KeyboardSafeAreaFloor: () => null }));
vi.mock('../../src/lib/power-level-options', () => ({
  buildPowerLevelOptions: () => [{ id: 'auto' }],
}));
vi.mock('../../src/components/AmbientField', () => ({
  AmbientField: (props: Record<string, unknown>) => {
    world.field.push(props);
    return React.createElement('AmbientField', props);
  },
}));
vi.mock('../../src/components/thread/AliaThread', () => ({ AliaThread: () => null }));
vi.mock('../../src/components/thread/ThreadSearch', () => ({ ThreadSearch: () => null }));
vi.mock('../../src/components/AliaWelcomeMessage', () => ({ AliaWelcomeMessage: () => null }));
vi.mock('../../src/components/AliaComposer', () => ({
  AliaComposer: (props: Record<string, any>) => {
    React.useEffect(() => {
      world.composer.mounts += 1;
      return () => {
        world.composer.unmounts += 1;
      };
    }, []);
    world.composer.props = props;
    return props.emptyAction ?? null;
  },
}));
vi.mock('../../src/components/VoiceModeIcon', () => ({ VoiceModeIcon: () => null }));
vi.mock('../../src/components/voice/AliaVoiceCall', () => ({
  AliaVoiceCall: (props: Record<string, unknown>) => {
    world.call = props;
    return React.createElement('VoiceCall', props);
  },
}));
vi.mock('../../src/hooks/useTTS', () => ({
  useTTS: () => ({
    readAloud: () => {},
    playbackState: 'idle',
    ttsWaveAmplitude: 0,
    activeMessageId: null,
  }),
}));
vi.mock('../../src/hooks/useAmbientWave', () => ({
  useAmbientWave: () => ({ waveAmplitude: 0, agentState: 'idle', intensity: 0.4 }),
}));
vi.mock('../../src/hooks/useFocusWhenPresented', () => ({ useFocusWhenPresented: () => {} }));
vi.mock('../../src/hooks/useImagePicker', () => ({
  useImagePicker: () => ({ pickImage: async () => [] }),
}));
vi.mock('../../src/hooks/useSoundEffects', () => ({ useVoiceSoundEffects: () => {} }));
vi.mock('../../src/hooks/useComposerSuggestions', () => ({
  useComposerSuggestions: () => ({ completions: [], selected: -1, onKeyPress: () => {} }),
  useSuggestionQuery: () => '',
}));
vi.mock('../../src/lib/image-data-url', () => ({ imageUriToDataUrl: async (u: string) => u }));
vi.mock('../../src/runtime/use-agent-activity', () => ({ useAgentActivity: () => ({}) }));
vi.mock('../../src/runtime/use-conversation-stream', () => ({
  useConversationStream: () => ({
    messages: world.messages,
    append: async (message: { role: string; content: unknown }, options?: unknown) => {
      world.appended.push({ message, options });
      return 'sent';
    },
    isLoading: world.isLoading,
    error: world.error,
    clearError: world.clearError,
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
vi.mock('../../src/runtime/conversations', () => ({
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  useConversation: () => ({ data: undefined, error: null, isLoading: false, isFetching: false }),
  useCreateConversation: () => ({ mutateAsync: async () => ({ id: 'made' }), mutate: () => {} }),
  useDeleteConversation: () => ({ mutateAsync: async () => {} }),
  useClearConversation: () => ({ mutateAsync: async () => {} }),
}));
vi.mock('../../src/runtime/attachment-utils', () => ({
  buildMessageContent: async (text: string) => ({ content: text, dropped: [] }),
}));

import { AliaChatContent } from '../../src/components/AliaChatContent';
import { useComposerDraftStore } from '../../src/runtime/composer-draft-store';
import { UsageLimitError } from '../../src/runtime/usage-limit-error';
import { useVoiceCallRequests } from '../../src/lib/voice-call-request';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: TestRenderer.ReactTestRenderer | undefined;

function tree(props: React.ComponentProps<typeof AliaChatContent> = {}) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <AliaChatContent conversationId="c1" {...props} />
    </QueryClientProvider>
  );
}
function mount(props?: React.ComponentProps<typeof AliaChatContent>) {
  act(() => {
    renderer = TestRenderer.create(tree(props));
  });
}
const update = (props?: React.ComponentProps<typeof AliaChatContent>) =>
  act(() => renderer?.update(tree(props)));

const draftOf = () => useComposerDraftStore.getState().drafts.c1;
const composer = () => world.composer.props as Record<string, any>;
const press = () => act(async () => world.startVoice?.());

beforeEach(() => {
  world.messages = [];
  world.isLoading = false;
  world.error = null;
  world.appended = [];
  world.signedIn = true;
  world.startVoice = null;
  world.composer = { mounts: 0, unmounts: 0, props: null };
  world.field = [];
  world.call = null;
  world.clearError.mockClear();
  useVoiceCallRequests.getState().clear();
  useComposerDraftStore.setState({ account: 'u1', drafts: {} });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('a call replaces dictation', () => {
  it("draws the composer — dictation's only door — until a call starts, and the call bar instead of it during one", async () => {
    mount();
    expect(world.composer.mounts).toBe(1);
    expect(renderer?.root.findAllByType('VoiceCall' as never)).toHaveLength(0);

    await press();

    // Unmounted, not hidden: an unmounted `useDictation` is what lets go of the microphone.
    expect(world.composer.unmounts).toBe(1);
    expect(renderer?.root.findAllByType('VoiceCall' as never)).toHaveLength(1);
  });

  it('keeps the draft across the call', async () => {
    mount();
    act(() => composer().onValueChange('dictado a medias'));
    await press();

    expect(draftOf()?.text).toBe('dictado a medias');
    expect(world.call).not.toBeNull();
  });

  it('is not offered where the host made the chat text-only', () => {
    mount({ voice: false });
    expect(composer().emptyAction).toBeUndefined();
  });
});

describe('the ambient field behind the chat', () => {
  it('is exactly one layer, and it runs while the screen is on show', () => {
    mount();
    expect(renderer?.root.findAllByType('AmbientField' as never)).toHaveLength(1);
    expect(world.field.at(-1)?.paused).toBe(false);
  });

  it('pauses while another route covers the screen', () => {
    mount({ isFocused: false });
    expect(world.field.at(-1)?.paused).toBe(true);
  });

  it('is the screen’s shape unless the frame is a sheet', () => {
    mount();
    expect(world.field.at(-1)?.layout).toBe('screen');
    update({ layout: 'sheet' });
    expect(world.field.at(-1)?.layout).toBe('sheet');
  });

  it('gives the empty chat the field at its full strength, and a conversation the quiet one', () => {
    mount();
    expect(world.field.at(-1)?.intensity).toBe(1);
    world.messages = [{ id: 'm1', role: 'user', content: 'hi' }];
    update();
    expect(world.field.at(-1)?.intensity).toBe(0.4);
  });
});

describe("Alia's questions", () => {
  const asked = {
    id: 'a1',
    role: 'assistant',
    content: '',
    toolInvocations: [
      {
        toolCallId: 't1',
        toolName: 'askUserQuestion',
        state: 'result',
        args: {
          questions: [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }],
        },
      },
    ],
  };

  it('are asked above the composer, and the answer is sent as the next message', () => {
    world.messages = [asked];
    mount();

    const questions = composer().questions as { items: unknown[]; onSubmit: (m: string) => void };
    expect(questions.items).toHaveLength(1);
    questions.onSubmit('A');
    expect(world.appended).toEqual([
      {
        message: { role: 'user', content: 'A' },
        options: { mcpServerId: null, skillNames: [] },
      },
    ]);
  });

  it('are not asked while she is still answering, or once anything follows them', () => {
    world.messages = [asked];
    world.isLoading = true;
    mount();
    expect(composer().questions.items).toHaveLength(0);

    world.isLoading = false;
    world.messages = [asked, { id: 'u2', role: 'user', content: 'A' }];
    update();
    expect(composer().questions.items).toHaveLength(0);
  });
});

describe('rewriting a question', () => {
  const thread = [
    { id: 'u1', role: 'user', content: 'first question' },
    { id: 'a1', role: 'assistant', content: 'first answer' },
  ];
  const startEdit = () =>
    act(() => {
      const store = useComposerDraftStore.getState();
      store.startEdit(store.address('c1'), {
        messageId: 'u1',
        text: 'first question',
        mcpServerId: null,
        skillNames: [],
      });
    });

  it('draws the strip of what is happening in place of the tab, and a placeholder that says so', () => {
    world.messages = thread;
    mount({ composerStatus: React.createElement('Project') });
    expect(composer().status).toEqual(React.createElement('Project'));

    startEdit();

    expect(composer().status).not.toEqual(React.createElement('Project'));
    expect(composer().placeholder).toBe('Edit your message');
  });

  it('is left by Escape, as its Cancel does, and the composer is a new turn again', () => {
    world.messages = thread;
    mount();
    startEdit();
    const preventDefault = vi.fn();

    act(() => composer().onKeyPress({ nativeEvent: { key: 'Escape' }, preventDefault }));

    expect(preventDefault).toHaveBeenCalled();
    expect(draftOf()?.editing).toBeUndefined();
  });
});

describe('a turn refused for the usage limit', () => {
  const limit = new UsageLimitError({ type: 'daily' } as never);

  it('closes the composer and hands the host what to say, with the way to dismiss it', () => {
    world.error = limit;
    const renderUsageLimit = vi.fn(() => null);
    mount({ renderUsageLimit });

    expect(composer().disabled).toBe(true);
    expect(composer().placeholder).toBe('Usage limit reached');
    const [{ error, dismiss }] = renderUsageLimit.mock.calls[0] as unknown as [
      { error: Error; dismiss: () => void },
    ];
    expect(error).toBe(limit);
    dismiss();
    expect(world.clearError).toHaveBeenCalledTimes(1);
  });

  it('leaves the composer open for every other error', () => {
    world.error = new Error('boom');
    const renderUsageLimit = vi.fn(() => null);
    mount({ renderUsageLimit });

    expect(composer().disabled).toBe(false);
    expect(renderUsageLimit).not.toHaveBeenCalled();
  });
});

describe('sending', () => {
  it('sends the draft with the options it was written with, and empties it', async () => {
    mount();
    act(() => {
      const store = useComposerDraftStore.getState();
      store.setText(store.address('c1'), '  hello  ');
      store.updateTurn(store.address('c1'), (turn) => ({ ...turn, skillNames: ['digest'] }));
    });

    await act(async () => composer().onSubmit());

    expect(world.appended).toEqual([
      {
        message: { role: 'user', content: 'hello' },
        options: { mcpServerId: null, skillNames: ['digest'] },
      },
    ]);
    // Cleared at once; a failed send would hand it back.
    expect(draftOf()?.text ?? '').toBe('');
  });

  it('asks a signed-out person to sign in instead, and keeps their draft', async () => {
    world.signedIn = false;
    const onSignInRequired = vi.fn();
    mount({ onSignInRequired });
    act(() => composer().onValueChange('hello'));

    await act(async () => composer().onSubmit());

    expect(onSignInRequired).toHaveBeenCalledTimes(1);
    expect(world.appended).toEqual([]);
    expect(draftOf()?.text).toBe('hello');
  });

  it('sends nothing while the composer is closed or a turn is running', async () => {
    mount();
    act(() => composer().onValueChange('hello'));
    world.isLoading = true;
    update();

    await act(async () => composer().onSubmit());
    expect(world.appended).toEqual([]);
  });
});

describe('the power level', () => {
  it('is selectable only where the host can keep the choice', () => {
    mount({ model: 'pro' });
    expect(composer().modes).toBeUndefined();

    const onModelChange = vi.fn();
    update({ model: 'pro', onModelChange });
    expect(composer().modes).toEqual([{ id: 'auto' }]);
    expect(composer().mode).toBe('pro');
    composer().onModeChange('ultra');
    expect(onModelChange).toHaveBeenCalledWith('ultra');
  });
});
