/**
 * Shared chat content component used by both AliaChatSheet and AliaChatScreen.
 *
 * Owns all chat + voice state internally. Containers only handle
 * layout chrome (sheet modal, full-screen SafeAreaView) and pass a `header`
 * render prop that receives the live mark state.
 */

import React, {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { View, StyleSheet } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { Volume2 } from 'lucide-react-native';
import { useAliaChat, type UseAliaChatOptions } from '../hooks/useAliaChat';
import { useVoiceRoom } from '../hooks/useVoiceRoom';
import { useAudioLevelMonitor } from '../hooks/useAudioLevelMonitor';
import { useAudioLevels } from '../hooks/useAudioLevels';
import { useTTS } from '../hooks/useTTS';
import { useAmbientWave } from '../hooks/useAmbientWave';
import { VoiceOverlay } from './voice/VoiceOverlay';
import { VoiceControls } from './voice/VoiceControls';
import { AliaChatMessageList } from './AliaChatMessageList';
import { AliaWelcomeMessage, type WelcomeSuggestion } from './AliaWelcomeMessage';
import { PromptInput } from './ui/prompt-input/prompt-input';
import { Button } from './ui/button';
import type { AliaMarkState } from './AliaMark';
import type { ChatMessage, VoiceMessage } from '../types';
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

  // ── Voice room ──
  const voiceRoom = useVoiceRoom({ apiUrl });
  const { captureLevel, playbackLevel } = useAudioLevelMonitor(voiceRoom.room, voiceRoom.isConnected);
  const { waveAmplitude } = useAudioLevels({
    captureLevel,
    playbackLevel,
    agentState: voiceRoom.agentState,
    isConnected: voiceRoom.isConnected,
  });

  // ── TTS ──
  const tts = useTTS({ apiUrl });

  // ── Voice mode state ──
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const textSnapshotRef = useRef<ChatMessage[]>([]);

  // Merge voice messages into chat messages
  useEffect(() => {
    if (!isVoiceActive) return;
    const adapted = voiceRoom.messages.map(adaptVoiceMessage);
    setMessages([...textSnapshotRef.current, ...adapted]);
  }, [voiceRoom.messages, isVoiceActive, setMessages]);

  // Auto-deactivate on error
  useEffect(() => {
    if (!isVoiceActive) return;
    if (voiceRoom.error) {
      deactivateVoice();
    } else if (voiceRoom.roomState === 'error') {
      deactivateVoice();
    }
  }, [voiceRoom.error, voiceRoom.roomState, isVoiceActive]);

  // Auto-deactivate on unexpected disconnection
  useEffect(() => {
    if (!isVoiceActive) return;
    if (voiceRoom.roomState === 'disconnected' && textSnapshotRef.current.length > 0) {
      deactivateVoice();
    }
  }, [voiceRoom.roomState, isVoiceActive]);

  const activateVoice = useCallback(() => {
    if (isVoiceActive || voiceRoom.roomState === 'connecting') return;
    textSnapshotRef.current = [...messages];
    setIsVoiceActive(true);
    voiceRoom.connect();
  }, [isVoiceActive, voiceRoom, messages]);

  const deactivateVoice = useCallback(() => {
    voiceRoom.disconnect();
    setIsVoiceActive(false);
    textSnapshotRef.current = [];
  }, [voiceRoom]);

  // ── TTS read aloud handler ──
  const handleReadAloud = useCallback(
    (messageId: string, text: string) => {
      tts.readAloud(messageId, text);
    },
    [tts],
  );

  // ── Mark state (drives the header brand mark) ──
  const markState = useMemo<AliaMarkState>(() => {
    if (isVoiceActive) {
      if (voiceRoom.agentState === 'speaking') return 'writing';
      if (voiceRoom.agentState === 'thinking') return 'thinking';
      return 'idle';
    }
    if (!isStreaming) return 'idle';
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === 'assistant' && lastMsg.toolInvocations?.some((t) => t.state === 'call'))
      return 'working';
    if (lastMsg?.thinking) return 'thinking';
    return 'writing';
  }, [messages, isStreaming, isVoiceActive, voiceRoom.agentState]);

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
    voice: {
      isActive: isVoiceActive,
      isConnected: voiceRoom.isConnected,
      agentState: voiceRoom.agentState,
      waveAmplitude,
    },
    isTTSPlaying: tts.playbackState === 'playing',
    ttsWaveAmplitude: tts.ttsWaveAmplitude,
    isGenerating: isStreaming,
  });

  // ── Voice activate button for empty submit ──
  const voiceActivateButton = useMemo(
    () => (
      <Button
        size="icon"
        onPress={activateVoice}
        className="h-8 w-8 rounded-full"
      >
        <Volume2 size={16} color="white" />
      </Button>
    ),
    [activateVoice],
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
      {isVoiceActive ? (
        <VoiceControls
          roomState={voiceRoom.roomState}
          agentState={voiceRoom.agentState}
          isMuted={voiceRoom.isMuted}
          cohostActive={voiceRoom.cohostActive}
          currentSpeaker={voiceRoom.currentSpeaker}
          roundComplete={voiceRoom.roundComplete}
          onToggleMute={voiceRoom.toggleMute}
          onEnableCohost={voiceRoom.enableCohost}
          onDisableCohost={voiceRoom.disableCohost}
          onContinueCohost={voiceRoom.continueCohost}
          onEnd={deactivateVoice}
        />
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
