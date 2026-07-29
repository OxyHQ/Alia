/**
 * Shared chat content component used by both AliaChatSheet and AliaChatScreen.
 *
 * Owns the text chat; voice is an injected capability (`voiceSession`) so that
 * nothing here reaches `livekit-client` at module-evaluation time. Containers
 * only handle layout chrome (sheet modal, full-screen SafeAreaView) and pass a
 * `header` render prop that receives the live mark state.
 */

import React, {
  Suspense,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { View, StyleSheet } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import Volume2 from 'lucide-react-native/icons/volume-2';
import { useAliaChat, type UseAliaChatOptions } from '../hooks/useAliaChat';
import { useTTS } from '../hooks/useTTS';
import { useAmbientWave } from '../hooks/useAmbientWave';
import { VoiceOverlay } from './voice/VoiceOverlay';
import { AliaChatMessageList } from './AliaChatMessageList';
import { AliaWelcomeMessage, type WelcomeSuggestion } from './AliaWelcomeMessage';
import { PromptInput } from './ui/prompt-input/prompt-input';
import { Button } from './ui/button';
import type { AliaMarkState } from './AliaMark';
import type {
  ChatMessage,
  VoiceMessage,
  VoiceSessionComponent,
  VoiceSessionState,
} from '../types';
import type { Completion } from './ui/prompt-input/context';

export interface AliaChatContentProps {
  clientContext?: string;
  model?: string;
  apiUrl?: string;
  /** Shared value for scroll offset (used by sheet for pan-to-dismiss) */
  scrollOffsetY?: SharedValue<number>;
  /** Injectable autocomplete hook */
  useSuggestions?: (query: string) => { data: Completion[] | undefined; isLoading: boolean };
  /** Called when a suggestion is selected from autocomplete */
  onSuggestionUsed?: (suggestionId: string) => void;
  /** Error handler (e.g. toast) */
  onError?: (message: string) => void;
  // Welcome message
  welcomeGreeting?: string;
  welcomeSubtitle?: string;
  welcomeSuggestions?: WelcomeSuggestion[];
  // Message action callbacks
  onEditMessage?: (messageId: string, newContent: string) => void;
  onThumbsUp?: (messageId: string) => void;
  onThumbsDown?: (messageId: string) => void;
  onApprovePlan?: (planId: string) => void;
  onRejectPlan?: (planId: string) => void;
  onToolResultPress?: (messageId: string) => void;
  /** Override markdown renderer (app passes CustomMarkdown) */
  renderMarkdown?: (content: string) => React.ReactNode;
  /** Header bar render prop — receives live mark state, message presence, and the clear handler. */
  header?: (state: { markState: AliaMarkState; hasMessages: boolean; clear: () => void }) => React.ReactNode;
  /** Theme primary color hex — forwarded to the ambient wave overlay palette. */
  primaryColor?: string;
  /** Dark-mode flag — forwarded to the ambient wave overlay. */
  isDarkMode?: boolean;
  /**
   * Voice capability — pass `VoiceSession` from `@alia.onl/sdk/voice` to offer
   * voice calls. Omitted, the chat is text-only and no LiveKit code is reachable
   * from this module. May be a `React.lazy` component.
   */
  voiceSession?: VoiceSessionComponent;
}

/** Adapt a voice message into the chat message format. */
function adaptVoiceMessage(vm: VoiceMessage): ChatMessage {
  return {
    id: vm.id,
    role: vm.role,
    content: vm.content,
    toolInvocations: vm.toolInvocations,
    createdAt: Date.now(),
    source: 'voice' as const,
    speaker: vm.speaker,
  };
}

export function AliaChatContent({
  clientContext,
  model,
  apiUrl,
  scrollOffsetY: externalScrollOffsetY,
  useSuggestions,
  onSuggestionUsed,
  onError,
  welcomeGreeting,
  welcomeSubtitle,
  welcomeSuggestions,
  onEditMessage,
  onThumbsUp,
  onThumbsDown,
  onApprovePlan,
  onRejectPlan,
  onToolResultPress,
  renderMarkdown,
  header,
  primaryColor,
  isDarkMode,
  voiceSession: VoiceSession,
}: AliaChatContentProps) {
  // ── Chat ──
  const chatOptions: UseAliaChatOptions = { apiUrl, model, clientContext };
  const { messages, setMessages, send, isStreaming, stop, clear } = useAliaChat(chatOptions);

  // ── Input state ──
  const [inputValue, setInputValue] = useState('');

  const handleSubmit = useCallback(() => {
    const text = inputValue.trim();
    if (!text) return;
    send(text);
    setInputValue('');
  }, [inputValue, send]);

  // ── Scroll offset (use external if provided, else internal) ──
  const internalScrollOffsetY = useSharedValue(0);
  const scrollOffsetY = externalScrollOffsetY ?? internalScrollOffsetY;

  // ── TTS ──
  const tts = useTTS({ apiUrl });

  // ── Voice mode state ──
  // `isVoiceActive` mounts the session; `voiceState` is what the session reports
  // back, and stays null until the call is under way.
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceSessionState | null>(null);
  const textSnapshotRef = useRef<ChatMessage[]>([]);

  // Merge voice messages into chat messages
  const voiceMessages = voiceState?.messages;
  useEffect(() => {
    if (!voiceMessages) return;
    setMessages([...textSnapshotRef.current, ...voiceMessages.map(adaptVoiceMessage)]);
  }, [voiceMessages, setMessages]);

  const activateVoice = useCallback(() => {
    if (isVoiceActive) return;
    textSnapshotRef.current = [...messages];
    setIsVoiceActive(true);
  }, [isVoiceActive, messages]);

  // Unmounting the session disconnects the room; the transcript merged above
  // stays in the chat.
  const deactivateVoice = useCallback(() => {
    setIsVoiceActive(false);
    setVoiceState(null);
    textSnapshotRef.current = [];
  }, []);

  // ── TTS read aloud handler ──
  const handleReadAloud = useCallback(
    (messageId: string, text: string) => {
      tts.readAloud(messageId, text);
    },
    [tts],
  );

  // ── Mark state (drives the header brand mark) ──
  const voiceAgentState = voiceState?.agentState;
  const markState = useMemo<AliaMarkState>(() => {
    if (isVoiceActive) {
      if (voiceAgentState === 'speaking') return 'writing';
      if (voiceAgentState === 'thinking') return 'thinking';
      return 'idle';
    }
    if (!isStreaming) return 'idle';
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'assistant' && lastMsg.toolInvocations?.some((t) => t.state === 'call'))
      return 'working';
    if (lastMsg?.thinking) return 'thinking';
    return 'writing';
  }, [messages, isStreaming, isVoiceActive, voiceAgentState]);

  const welcomeComponent = useMemo(() => {
    if (!welcomeGreeting || messages.length > 0) return undefined;
    return (
      <AliaWelcomeMessage
        greeting={welcomeGreeting}
        subtitle={welcomeSubtitle}
        suggestions={welcomeSuggestions}
        onSuggestionPress={send}
      />
    );
  }, [welcomeGreeting, welcomeSubtitle, welcomeSuggestions, send, messages.length]);

  // ── Ambient wave — one persistent overlay across idle/voice/TTS/STT ──
  const wave = useAmbientWave({
    voice: voiceState
      ? {
          isActive: isVoiceActive,
          isConnected: voiceState.isConnected,
          agentState: voiceState.agentState,
          waveAmplitude: voiceState.waveAmplitude,
        }
      : undefined,
    isTTSPlaying: tts.playbackState === 'playing',
    ttsWaveAmplitude: tts.ttsWaveAmplitude,
    isGenerating: isStreaming,
  });

  // ── Voice activate button for empty submit (only if voice was provided) ──
  const voiceActivateButton = useMemo(
    () =>
      VoiceSession ? (
        <Button
          size="icon"
          onPress={activateVoice}
          className="h-8 w-8 rounded-full"
        >
          <Volume2 size={16} color="white" />
        </Button>
      ) : undefined,
    [VoiceSession, activateVoice],
  );

  return (
    <View style={styles.container}>
      {/* Header (render prop) */}
      {header?.({ markState, hasMessages: messages.length > 0, clear })}

      {/* Persistent ambient wave overlay */}
      <VoiceOverlay
        waveAmplitude={wave.waveAmplitude}
        agentState={wave.agentState}
        intensity={wave.intensity}
        primaryColor={primaryColor}
        isDarkMode={isDarkMode}
      />

      {/* Welcome or Messages */}
      <AliaChatMessageList
        messages={messages}
        isStreaming={isStreaming}
        scrollOffsetY={scrollOffsetY}
        onReadAloud={handleReadAloud}
        ttsActiveMessageId={tts.activeMessageId}
        ttsPlaybackState={tts.playbackState}
        onEditMessage={onEditMessage}
        onThumbsUp={onThumbsUp}
        onThumbsDown={onThumbsDown}
        onApprovePlan={onApprovePlan}
        onRejectPlan={onRejectPlan}
        onToolResultPress={onToolResultPress}
        renderMarkdown={renderMarkdown}
        welcomeComponent={welcomeComponent}
      />

      {/* Input or Voice Controls */}
      {VoiceSession && isVoiceActive ? (
        /* Suspense so the session may be handed to us as a React.lazy import. */
        <Suspense fallback={null}>
          <VoiceSession
            apiUrl={apiUrl}
            onStateChange={setVoiceState}
            onEnd={deactivateVoice}
          />
        </Suspense>
      ) : (
        <View style={styles.inputContainer}>
          <PromptInput
            value={inputValue}
            onValueChange={setInputValue}
            onSubmit={handleSubmit}
            isLoading={isStreaming}
            onStop={stop}
            emptyAction={voiceActivateButton}
            placeholder="Ask Alia..."
            apiUrl={apiUrl}
            autocomplete={!!useSuggestions}
            useSuggestions={useSuggestions}
            onSuggestionUsed={onSuggestionUsed}
            onError={onError}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'relative',
  },
  inputContainer: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
  },
});
