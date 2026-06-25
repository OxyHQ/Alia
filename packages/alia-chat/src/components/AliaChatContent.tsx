/**
 * Shared chat content component used by both AliaChatSheet and AliaChatScreen.
 *
 * Owns all chat + voice state internally. Containers only handle
 * layout chrome (sheet modal, full-screen SafeAreaView, headers).
 */

import React, {
  forwardRef,
  useImperativeHandle,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { View, StyleSheet } from 'react-native';
import { useSharedValue, withTiming, Easing } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { Volume2 } from 'lucide-react-native';
import { useAliaChat, type UseAliaChatOptions } from '../hooks/useAliaChat';
import { useVoiceRoom } from '../hooks/useVoiceRoom';
import { useAudioLevelMonitor } from '../hooks/useAudioLevelMonitor';
import { useAudioLevels } from '../hooks/useAudioLevels';
import { useTTS } from '../hooks/useTTS';
import { useSTTStore } from '../hooks/useSpeechToText';
import { VoiceOverlay } from './voice/VoiceOverlay';
import { VoiceControls } from './voice/VoiceControls';
import { AliaChatMessageList } from './AliaChatMessageList';
import { AliaWelcomeMessage, type WelcomeSuggestion } from './AliaWelcomeMessage';
import { PromptInput } from './ui/prompt-input/prompt-input';
import { Button } from './ui/button';
import type { AliaExpression } from './AliaFace';
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
}

export interface AliaChatContentRef {
  messages: ChatMessage[];
  isStreaming: boolean;
  isVoiceActive: boolean;
  faceExpression: AliaExpression;
  clear: () => void;
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

export const AliaChatContent = forwardRef<AliaChatContentRef, AliaChatContentProps>(
  ({
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
  }, ref) => {
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

    // ── STT wave overlay ──
    const sttIsRecording = useSTTStore((s) => s.isRecording);
    const sttMetering = useSTTStore((s) => s.metering);
    const sttWaveAmplitude = useSharedValue(0);

    useEffect(() => {
      if (!sttIsRecording) {
        sttWaveAmplitude.value = withTiming(0, { duration: 300 });
        return;
      }
      const target = Math.max(0.08, sttMetering);
      const duration = target > sttWaveAmplitude.value ? 60 : 200;
      sttWaveAmplitude.value = withTiming(target, {
        duration,
        easing: Easing.bezier(0.33, 1, 0.68, 1),
      });
    }, [sttIsRecording, sttMetering]);

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

    // ── Face expression ──
    const faceExpression = useMemo<AliaExpression>(() => {
      if (isVoiceActive) {
        if (voiceRoom.agentState === 'speaking') return 'Writing E';
        if (voiceRoom.agentState === 'thinking') return 'Thinking';
        return 'Idle A';
      }
      if (!isStreaming) return 'Idle A';
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === 'assistant' && lastMsg.toolInvocations?.some((t) => t.state === 'call'))
        return 'Searching A';
      if (lastMsg?.thinking) return 'Thinking';
      return 'Writing E';
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

    // ── Overlay state ──
    const showVoiceOverlay = isVoiceActive;
    const showTTSOverlay = !isVoiceActive && tts.playbackState === 'playing';
    const showSTTOverlay = !isVoiceActive && tts.playbackState !== 'playing' && sttIsRecording;

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

    // ── Expose state to container ──
    useImperativeHandle(
      ref,
      () => ({
        messages,
        isStreaming,
        isVoiceActive,
        faceExpression,
        clear,
      }),
      [messages, isStreaming, isVoiceActive, faceExpression, clear],
    );

    return (
      <View style={styles.container}>
        {/* Voice/TTS/STT wave overlay */}
        {showVoiceOverlay && (
          <VoiceOverlay
            waveAmplitude={waveAmplitude}
            agentState={voiceRoom.agentState}
            isConnected={voiceRoom.isConnected}
          />
        )}
        {showTTSOverlay && (
          <VoiceOverlay
            waveAmplitude={tts.ttsWaveAmplitude}
            agentState="speaking"
            isConnected={true}
          />
        )}
        {showSTTOverlay && (
          <VoiceOverlay
            waveAmplitude={sttWaveAmplitude}
            agentState="listening"
            isConnected={true}
          />
        )}

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
  },
);

AliaChatContent.displayName = 'AliaChatContent';

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
