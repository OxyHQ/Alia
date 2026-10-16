import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where the sheet's voice call lives: in the open conversation, or in one made when it starts.
 *
 * `AliaChatContent` is what the sheet, `AliaChatScreen` and the Alia app all mount, so this is the
 * rule for all three, with the real voice launcher and the real conversation thread under it. The
 * things that draw (composer, thread, call bar, ambient field) are stubs that record what they
 * were given; the stream and the REST calls are fakes.
 */

const world = vi.hoisted(() => ({
  created: [] as unknown[],
  failCreate: false,
  /** The mic button the composer was given while no call is open. */
  startVoice: null as null | (() => void),
  /** The call bar's props while a call is open. */
  call: null as null | { conversationId?: string },
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
  useOxy: () => ({ user: { id: 'u1' }, isAuthenticated: true }),
}));
vi.mock('@oxy.so/core', () => ({ getAccountDisplayName: () => 'Nate' }));
vi.mock('@oxy.so/bloom/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@oxy.so/bloom/button', () => ({
  Button: (props: { onPress?: () => void }) => {
    world.startVoice = props.onPress ?? null;
    return null;
  },
}));
vi.mock('@oxy.so/bloom/ai-chat', () => ({
  AiChatContainer: ({
    composer,
    children,
  }: {
    composer: React.ReactNode;
    children: React.ReactNode;
  }) => React.createElement('Container', null, children, composer),
}));
vi.mock('@oxy.so/bloom/avatar-flight', () => ({
  AvatarFlightLayer: () => null,
  useAvatarFlights: () => ({ launch: async () => {}, anchor: () => undefined }),
}));
vi.mock('@oxy.so/bloom/icons', () => ({ RiImageLine: () => null }));
vi.mock('@oxy.so/bloom/composer-panel', () => ({}));
vi.mock('../../src/components/AmbientField', () => ({ AmbientField: () => null }));
vi.mock('../../src/components/thread/AliaThread', () => ({ AliaThread: () => null }));
vi.mock('../../src/components/thread/ThreadSearch', () => ({ ThreadSearch: () => null }));
vi.mock('../../src/runtime/use-agent-activity', () => ({ useAgentActivity: () => ({}) }));
vi.mock('../../src/hooks/useThreadView', () => ({
  useThreadView: () => ({
    history: undefined,
    focusCursor: null,
    jumped: false,
    jump: () => {},
    backToLatest: () => {},
    searchOpen: false,
    openSearch: () => {},
    closeSearch: () => {},
  }),
}));
vi.mock('../../src/lib/power-level-options', () => ({ buildPowerLevelOptions: () => [] }));
vi.mock('../../src/hooks/useSoundEffects', () => ({ useVoiceSoundEffects: () => {} }));
vi.mock('../../src/lib/keyboard', () => ({ KeyboardSafeAreaFloor: () => null }));
vi.mock('@oxy.so/bloom/chat-screen', () => ({ ScrollToBottomButton: () => null }));
vi.mock('@oxy.so/bloom/typography', () => ({ Text: () => null }));
vi.mock('@oxy.so/bloom/icons/RiEditLine', () => ({ RiEditLine: () => null }));
vi.mock('@oxy.so/bloom/icons/RiImageLine', () => ({ RiImageLine: () => null }));
vi.mock('../../src/components/AliaWelcomeMessage', () => ({ AliaWelcomeMessage: () => null }));
vi.mock('../../src/components/AliaComposer', () => ({
  // The mic button the chat offers an empty composer.
  AliaComposer: ({ emptyAction }: { emptyAction?: React.ReactNode }) => emptyAction ?? null,
}));
vi.mock('../../src/components/VoiceModeIcon', () => ({ VoiceModeIcon: () => null }));
vi.mock('../../src/components/voice/AliaVoiceCall', () => ({
  AliaVoiceCall: (props: { conversationId?: string }) => {
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
  useAmbientWave: () => ({ waveAmplitude: 0, agentState: 'idle', intensity: 1 }),
}));
vi.mock('../../src/hooks/useFocusWhenPresented', () => ({ useFocusWhenPresented: () => {} }));
vi.mock('../../src/hooks/useImagePicker', () => ({
  useImagePicker: () => ({ pickImage: async () => [] }),
}));
vi.mock('../../src/hooks/useComposerSuggestions', () => ({
  useComposerSuggestions: () => ({}),
  useSuggestionQuery: () => '',
}));
vi.mock('../../src/lib/image-data-url', () => ({ imageUriToDataUrl: async (u: string) => u }));
vi.mock('../../src/runtime/use-conversation-stream', () => ({
  useConversationStream: () => ({
    messages: [],
    append: async () => 'sent',
    isLoading: false,
    error: null,
    clearError: () => {},
    setMessages: () => {},
    stop: () => {},
    suggestedNewConversation: null,
    dismissSuggestedNewConversation: () => {},
    failedTurn: null,
    retryFailedTurn: async () => 'sent',
    clearFailedTurn: () => {},
    turnOptionsOf: () => undefined,
  }),
}));
vi.mock('../../src/runtime/conversations', () => ({
  ConversationNotFoundError: class ConversationNotFoundError extends Error {},
  useConversation: () => ({ data: undefined, error: null, isLoading: false, isFetching: false }),
  useCreateConversation: () => ({
    mutateAsync: async (params: unknown) => {
      world.created.push(params);
      if (world.failCreate) throw new Error('offline');
      return { id: 'made' };
    },
  }),
  useDeleteConversation: () => ({ mutateAsync: async () => {} }),
  useClearConversation: () => ({ mutateAsync: async () => {} }),
}));

import { AliaChatContent } from '../../src/components/AliaChatContent';
import { useVoiceCallRequests } from '../../src/lib/voice-call-request';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let renderer: TestRenderer.ReactTestRenderer | undefined;

function mount(props: React.ComponentProps<typeof AliaChatContent> = {}) {
  act(() => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={new QueryClient()}>
        <AliaChatContent {...props} />
      </QueryClientProvider>,
    );
  });
}

const press = () => act(async () => world.startVoice?.());

beforeEach(() => {
  world.created = [];
  world.failCreate = false;
  world.startVoice = null;
  world.call = null;
  useVoiceCallRequests.getState().clear();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('the voice call of the conversation view', () => {
  it('lives in the open conversation, and makes no other', async () => {
    mount({ conversationId: 'c1' });
    await press();

    expect(world.created).toEqual([]);
    expect(world.call?.conversationId).toBe('c1');
  });

  it('lives in a conversation made when the call starts, on a chat that has none', async () => {
    const onConversationChange = vi.fn();
    mount({ onConversationChange });
    await press();

    expect(world.created).toHaveLength(1);
    expect(onConversationChange).toHaveBeenCalledWith('made');
    // The view now shows that conversation, and the call is in it.
    expect(world.call?.conversationId).toBe('made');
  });

  it("is a new stretch of the agent's thread when the chat is an agent's", async () => {
    mount({ agent: { id: 'agent-1' } });
    await press();

    expect(world.created).toEqual([{ agentId: 'agent-1' }]);
  });

  it('does not open when the conversation could not be made', async () => {
    world.failCreate = true;
    mount({});
    await press();

    expect(world.call).toBeNull();
  });

  it('opens on the screen the host navigates to, when the host owns the conversation', async () => {
    // A route-driven host (the Alia app): the new-chat screen asks, the host shows the conversation
    // in another screen, and THAT screen's view takes the call.
    const navigate = vi.fn();
    mount({ runtime: { openConversation: navigate } });
    await press();

    expect(navigate).toHaveBeenCalledWith('made');
    act(() => renderer?.unmount());
    world.call = null;
    mount({ conversationId: 'made' });
    expect((world.call as { conversationId?: string } | null)?.conversationId).toBe('made');
  });
});
