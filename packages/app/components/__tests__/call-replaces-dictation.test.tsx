import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A call and dictation never listen at the same time.
 *
 * Both recognize speech on the device, and there is one microphone and — on
 * iOS and Android — one recognizer module for the whole process. So the rule is
 * structural rather than a lock: dictation lives in the composer
 * (`useSpeechToText` inside `Composer`), and a call REPLACES the composer with
 * the call bar. Starting a call therefore unmounts the composer, and an
 * unmounted `useSpeechToText` aborts its recognizer, stops its microphone track
 * and clears the shared dictation state (pinned in the SDK's
 * `useSpeechToText.test.tsx`). During the call there is no composer and so no
 * way to start dictating; ending it brings the composer back.
 *
 * What this file pins is the half that lives in the app: which of the two the
 * screen draws, and that the draft typed or dictated before the call is still
 * there after it. `Composer` is a probe that records it was mounted and what it
 * was handed; the call bar is a probe that records its labels.
 */

const mounts = vi.hoisted(() => ({ composer: 0, composerUnmounts: 0, lastValue: '' as string }));
const bar = vi.hoisted(() => ({ labels: null as Record<string, string> | null }));

vi.mock('@/components/chat/composer/composer', async () => {
  const ReactModule = await import('react');
  return {
    Composer: (props: { value: string; onValueChange: (v: string) => void }) => {
      ReactModule.useEffect(() => {
        mounts.composer += 1;
        return () => {
          mounts.composerUnmounts += 1;
        };
      }, []);
      mounts.lastValue = props.value;
      return ReactModule.createElement('Composer', props);
    },
  };
});

vi.mock('@alia.onl/sdk/voice', async () => {
  const ReactModule = await import('react');
  return {
    VoiceControls: (props: { labels: Record<string, string> }) => {
      bar.labels = props.labels;
      return ReactModule.createElement('VoiceControls', props);
    },
    useAmbientWave: () => ({ waveAmplitude: 0, agentState: 'idle', intensity: 0 }),
  };
});

vi.mock('@/components/chat/chat-workspace', async () => {
  const ReactModule = await import('react');
  return {
    ChatWorkspace: ({ composer, children }: { composer: React.ReactNode; children: React.ReactNode }) =>
      ReactModule.createElement('ChatWorkspace', null, composer, children),
  };
});

vi.mock('@/components/chat-interface', () => ({ ChatInterface: () => null }));
vi.mock('@/components/ambient-field', () => ({ AmbientField: () => null }));
vi.mock('@/components/icons/voice-mode-icon', () => ({ VoiceModeIcon: () => null }));
vi.mock('@/components/chat/composer/use-alia-composer', () => ({
  useAliaComposer: () => ({
    attachments: [],
    turnOptions: {},
    restoreTurn: vi.fn(),
    clearTurn: vi.fn(),
    props: {},
  }),
}));
vi.mock('@/components/chat/composer/composer-suggestions', () => ({
  ComposerSuggestions: () => null,
  useComposerSuggestions: () => ({ completions: [], selected: null, onKeyPress: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-billing', () => ({ useEntitlements: () => ({ data: undefined }) }));
vi.mock('@/lib/hooks/use-credits', () => ({ useCredits: () => ({ data: undefined }) }));
vi.mock('@/lib/hooks/use-suggestions', () => ({ useRecordSuggestionUsage: () => ({ mutate: vi.fn() }) }));
vi.mock('@/lib/hooks/use-tts', () => ({ useTTS: () => ({ ttsWaveAmplitude: 0, playbackState: 'idle' }) }));
vi.mock('@/lib/hooks/use-at-bottom', () => ({ useAtBottom: () => ({ isAtBottom: true, onScroll: vi.fn() }) }));
vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => `t:${key}` }),
}));
vi.mock('@/lib/stores/global-store', () => {
  const state = { composerDraft: null, composerDraftSeq: 0, setGhostMode: () => undefined };
  const useStore = (selector: (s: typeof state) => unknown) => selector(state);
  useStore.getState = () => state;
  return { useStore };
});
vi.mock('@/lib/stores/projects-store', () => ({
  useProjectsStore: (selector: (s: { projects: [] }) => unknown) => selector({ projects: [] }),
}));
vi.mock('@/lib/useColorScheme', () => ({
  useColorScheme: () => ({ colors: { primary: '#000' }, isDarkColorScheme: false }),
}));
vi.mock('@oxy.so/bloom/button', () => ({ Button: () => null }));
vi.mock('@oxy.so/bloom/toast', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
vi.mock('@oxy.so/bloom/ai-chat', () => ({ AiChatMobileHeader: () => null }));
vi.mock('@oxy.so/bloom/composer-panel', () => ({ ComposerPanelStatusTab: () => null }));
vi.mock('@oxy.so/bloom/chat-screen', () => ({ ScrollToBottomButton: () => null }));
vi.mock('@oxy.so/services', () => ({ useAuth: () => ({ isAuthenticated: true, signIn: vi.fn() }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
      ReactModule.createElement('View', props, children),
  };
});

import { ChatPageContent } from '@/components/chat-page-content';

function voice(isVoiceActive: boolean) {
  return {
    isVoiceActive,
    activateVoice: vi.fn(),
    deactivateVoice: vi.fn(),
    roomState: isVoiceActive ? 'connected' : 'disconnected',
    agentState: isVoiceActive ? 'listening' : 'idle',
    isMuted: false,
    isConnected: isVoiceActive,
    toggleMute: vi.fn(),
    waveAmplitude: 0,
    captureLevel: 0,
    playbackLevel: 0,
  } as const;
}

function screen(isVoiceActive: boolean) {
  return React.createElement(ChatPageContent, {
    messages: [],
    isLoading: false,
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    conversationId: 'conv-1',
    voice: voice(isVoiceActive) as unknown as Parameters<typeof ChatPageContent>[0]['voice'],
  });
}

beforeEach(() => {
  mounts.composer = 0;
  mounts.composerUnmounts = 0;
  mounts.lastValue = '';
  bar.labels = null;
});

describe('a call replaces dictation', () => {
  it('draws the composer — dictation\'s only door — until a call starts, and the call bar instead of it during one', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(screen(false));
    });
    expect(renderer.root.findAllByType('Composer' as never)).toHaveLength(1);
    expect(renderer.root.findAllByType('VoiceControls' as never)).toHaveLength(0);

    act(() => {
      renderer.update(screen(true));
    });
    // Unmounted, not hidden: an unmounted `useSpeechToText` is what lets go of the microphone.
    expect(mounts.composerUnmounts).toBe(1);
    expect(renderer.root.findAllByType('Composer' as never)).toHaveLength(0);
    expect(renderer.root.findAllByType('VoiceControls' as never)).toHaveLength(1);

    act(() => {
      renderer.update(screen(false));
    });
    expect(mounts.composer).toBe(2);
    expect(renderer.root.findAllByType('VoiceControls' as never)).toHaveLength(0);
  });

  it('keeps the draft across the call', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(screen(false));
    });
    const composer = renderer.root.findByType('Composer' as never);
    act(() => {
      (composer.props as { onValueChange: (v: string) => void }).onValueChange('dictado a medias');
    });

    act(() => {
      renderer.update(screen(true));
    });
    act(() => {
      renderer.update(screen(false));
    });
    expect(mounts.lastValue).toBe('dictado a medias');
  });

  it('labels the call bar in the app\'s language', () => {
    act(() => {
      create(screen(true));
    });
    expect(bar.labels).toMatchObject({
      listening: 't:voice.controls.listening',
      mute: 't:voice.controls.mute',
      end: 't:voice.controls.end',
    });
  });
});
