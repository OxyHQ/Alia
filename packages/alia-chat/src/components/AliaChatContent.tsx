/**
 * Shared chat content component used by both AliaChatSheet and AliaChatScreen.
 *
 * Owns the text chat; voice is an injected capability (`voiceSession`) so that
 * nothing here reaches `livekit-client` at module-evaluation time. Containers
 * only handle layout chrome (sheet modal, full-screen SafeAreaView). The
 * breadcrumb header is Bloom's `AiChatContainer`, the one the app's conversation uses.
 */

import React, {
  createContext,
  Suspense,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { View, StyleSheet } from 'react-native';
import { useAliaChat, type UseAliaChatOptions } from '../hooks/useAliaChat';
import { useTTS } from '../hooks/useTTS';
import { useSpeechToText } from '../hooks/useSpeechToText';
import { useImagePicker } from '../hooks/useImagePicker';
import { imageUriToDataUrl } from '../lib/image-data-url';
import { useAmbientWave } from '../hooks/useAmbientWave';
import { AmbientField } from './AmbientField';
import { QuestionCard } from './QuestionCard';
import { pendingQuestions } from '../lib/questions';
import { AliaChatMessageList } from './AliaChatMessageList';
import { AliaWelcomeMessage } from './AliaWelcomeMessage';
import { ComposerSuggestions } from './ComposerSuggestions';
import { useComposerSuggestions, useSuggestionQuery } from '../hooks/useComposerSuggestions';
import { ComposerLoader } from '@oxy.so/bloom/composer-loader';
import { AiChatContainer } from '@oxy.so/bloom/ai-chat';
import { ComposerPill, type ComposerPanelAddMenuGroup } from '@oxy.so/bloom/composer-panel';
import { RiImageLine } from '@oxy.so/bloom/icons';
import { toast } from '@oxy.so/bloom/toast';
import { Button } from '@oxy.so/bloom/button';
import { type AliaChatLabels, AliaChatLabelsProvider, useLabels } from '../lib/labels';
import { AliaAvatar, type AliaAvatarState } from './AliaAvatar';
import { VoiceModeIcon } from './VoiceModeIcon';
import type {
  AliaSuggestion,
  ChatMessage,
  VoiceMessage,
  VoiceSessionComponent,
  VoiceSessionState,
} from '../types';

/** The distinct delegated agents among `messages`, in the order they first answered. */
function participatingAgents(messages: readonly ChatMessage[]): AliaChatAgent[] {
  const seen = new Map<string, AliaChatAgent>();
  for (const { agentInfo } of messages) {
    if (agentInfo && !seen.has(agentInfo.id)) seen.set(agentInfo.id, agentInfo);
  }
  return [...seen.values()];
}

/** An agent that answered in the conversation, as the header shows it beside Alia. */
export interface AliaChatAgent {
  id: string;
  name: string;
}

/** What the chat tells its header and actions: whether there is a conversation to clear, and who took part. */
export interface AliaChatState {
  hasMessages: boolean;
  clear: () => void;
  /** The delegated agents that have answered, in the order they first did. */
  agents: AliaChatAgent[];
}

/** A turn of the person's: the text, and the photos (`data:` or `https:` URLs) sent with it. */
export interface AliaTurn {
  text: string;
  images?: ReadonlyArray<string>;
}

export interface AliaChatContentProps {
  clientContext?: string;
  model?: string;
  apiUrl?: string;
  /** Error handler (e.g. toast) */
  onError?: (message: string) => void;
  // Welcome message
  welcomeGreeting?: string;
  welcomeSubtitle?: string;
  /** The lines offered over the composer on an empty chat. */
  welcomeSuggestions?: AliaSuggestion[];
  /** What the host found for the typed text (see `onSuggestionQuery`). */
  suggestionMatches?: AliaSuggestion[];
  /** The typed text, once typing has settled, for the host to search suggestions with. */
  onSuggestionQuery?: (query: string) => void;
  // Message action callbacks
  onEditMessage?: (messageId: string, newContent: string) => void;
  onThumbsUp?: (messageId: string) => void;
  onThumbsDown?: (messageId: string) => void;
  onApprovePlan?: (planId: string) => void;
  onRejectPlan?: (planId: string) => void;
  /** Override markdown renderer (app passes CustomMarkdown) */
  renderMarkdown?: (content: string) => React.ReactNode;
  /** Breadcrumb title beside the brand mark. Default `Alia`; `null` drops the breadcrumb. */
  title?: string | null;
  /**
   * Above the breadcrumb row — a back button, a menu, or a whole custom header
   * (given `title={null}`). A function receives the clear handler.
   */
  headerLeading?: React.ReactNode | ((state: AliaChatState) => React.ReactNode);
  /** Right end of the breadcrumb row; receives the clear handler. Replaces Bloom's share/more. */
  actions?: (state: AliaChatState) => React.ReactNode;
  /** Dark-mode flag — forwarded to the ambient wave overlay. */
  isDarkMode?: boolean;
  /**
   * Voice capability — pass `VoiceSession` from `@alia.onl/sdk/voice` to offer
   * voice calls. Omitted, the chat is text-only and no LiveKit code is reachable
   * from this module. May be a `React.lazy` component.
   */
  voiceSession?: VoiceSessionComponent;
  /**
   * Space the composer keeps clear at the bottom edge, in px — the home indicator, when the
   * chat is flush with the screen (a phone sheet). The ambient background still runs behind it.
   */
  bottomInset?: number;
  /**
   * Hands the first turn of an empty chat to the host instead of sending it here — a sheet opens
   * the conversation in a new sheet over this one. Omitted, the chat sends it itself.
   */
  onStart?: (turn: AliaTurn) => void;
  /** A turn sent once as this chat mounts: the conversation a sheet was opened for. */
  initialTurn?: AliaTurn;
  /** Internal sheet lifecycle bridge: receives the live request canceller. */
  onStopReady?: (stop: (() => void) | null) => void;
  /** Overrides for the chat's own copy; anything omitted is English. */
  labels?: Partial<AliaChatLabels>;
}

/** The live state of the chat, read by the avatar wherever the header or welcome draws it. */
const MarkStateContext = createContext<AliaAvatarState>('idle');

/** Alia's avatar at any size, following the chat's live state. */
export function AliaChatMark({ size, reactionKey }: { size: number; reactionKey?: number }) {
  return <AliaAvatar size={size} state={useContext(MarkStateContext)} reactionKey={reactionKey} />;
}

/** `AiChatContainer`'s `projectIcon` takes a component that is handed its size as `width`. */
function BreadcrumbMark({ width }: { width?: number }) {
  return <AliaChatMark size={width ?? 16} />;
}

/** The add menu: photos are the one attachment the chat API carries (`image_url` parts). */
function addMenu(labels: AliaChatLabels): ComposerPanelAddMenuGroup[] {
  return [
    {
      label: labels.addMenuGroup,
      rows: [{ id: 'photos', label: labels.addPhotos, icon: RiImageLine }],
    },
  ];
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

function AliaChatContentBody({
  clientContext,
  model,
  apiUrl,
  onError,
  welcomeGreeting,
  welcomeSubtitle,
  welcomeSuggestions,
  suggestionMatches,
  onSuggestionQuery,
  onEditMessage,
  onThumbsUp,
  onThumbsDown,
  onApprovePlan,
  onRejectPlan,
  renderMarkdown,
  title = 'Alia',
  headerLeading,
  actions,
  isDarkMode,
  voiceSession: VoiceSession,
  bottomInset = 0,
  onStart,
  initialTurn,
  onStopReady,
}: AliaChatContentProps) {
  const labels = useLabels();
  const addMenuGroups = useMemo(() => addMenu(labels), [labels]);

  // A failure reaches the host's handler when it has one, and Bloom's toast otherwise.
  const reportError = useCallback(
    (message: string, title?: string) => {
      if (onError) onError(title ? `${title}: ${message}` : message);
      else toast.error(title ?? message, title ? { description: message } : undefined);
    },
    [onError],
  );
  // ── Chat ──
  const chatOptions: UseAliaChatOptions = { apiUrl, model, clientContext };
  const { messages, setMessages, send, isStreaming, stop, clear } = useAliaChat(chatOptions);
  const agents = useMemo(() => participatingAgents(messages), [messages]);
  // What Alia asked in her last turn and the person has not answered: asked above the composer,
  // not in the thread. Any later message, typed or sent from the card, is the answer.
  const lastMessage = messages.at(-1);
  const questionsAsked = useMemo(
    () => pendingQuestions(messages, isStreaming),
    [messages, isStreaming],
  );
  const [dismissedQuestionsOf, setDismissedQuestionsOf] = useState<string | null>(null);
  const asking = questionsAsked.length > 0 && dismissedQuestionsOf !== lastMessage?.id;
  const chatState: AliaChatState = { hasMessages: messages.length > 0, clear, agents };

  // The first turn of an empty chat goes to the host when it asked for it; every other turn is sent here.
  const startsElsewhere = onStart !== undefined && messages.length === 0;
  const submitTurn = useCallback(
    (text: string, images?: ReadonlyArray<string>) => {
      if (startsElsewhere) onStart({ text, images });
      else send(text, images ? { images } : undefined);
    },
    [startsElsewhere, onStart, send],
  );

  // The conversation this chat was opened for, sent once.
  const initialSent = useRef(false);
  useEffect(() => {
    if (!initialTurn || initialSent.current) return;
    initialSent.current = true;
    send(initialTurn.text, initialTurn.images ? { images: initialTurn.images } : undefined);
  }, [initialTurn, send]);

  useEffect(() => {
    onStopReady?.(stop);
    return () => onStopReady?.(null);
  }, [onStopReady, stop]);

  // ── Input state ──
  const [inputValue, setInputValue] = useState('');

  // Picked photos wait here, as tiles above the field, until the turn is sent.
  const [photos, setPhotos] = useState<Array<{ id: string; name: string; uri: string }>>([]);
  const { pickImage } = useImagePicker();

  const handleAddMenuSelect = useCallback(
    async (rowId: string) => {
      if (rowId !== 'photos') return;
      const assets = await pickImage();
      if (!assets?.length) return;
      setPhotos((prev) => [
        ...prev,
        ...assets.map((asset) => ({
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: asset.name,
          uri: asset.uri,
        })),
      ]);
    },
    [pickImage],
  );

  // Suggestions over the composer on an empty chat, as the Alia app has them.
  const suggestionQuery = useSuggestionQuery(inputValue, messages.length === 0);
  useEffect(() => {
    onSuggestionQuery?.(suggestionQuery);
  }, [suggestionQuery, onSuggestionQuery]);
  const handlePickSuggestion = useCallback(
    (suggestion: AliaSuggestion) => {
      setInputValue('');
      submitTurn(suggestion.text);
    },
    [submitTurn],
  );
  const suggestions = useComposerSuggestions({
    draft: inputValue,
    enabled: messages.length === 0,
    welcome: welcomeSuggestions,
    matches: suggestionMatches,
    onPick: handlePickSuggestion,
  });

  const handleSubmit = useCallback(
    async (value: string) => {
      const text = value.trim();
      if (!text && photos.length === 0) return;
      const pending = photos;
      setInputValue('');
      setPhotos([]);
      try {
        const images = await Promise.all(pending.map((photo) => imageUriToDataUrl(photo.uri)));
        submitTurn(text, images);
      } catch (err) {
        // Keep the draft: the photos could not be read, nothing was sent.
        setInputValue(value);
        setPhotos(pending);
        reportError(err instanceof Error ? err.message : 'Could not attach the photos');
      }
    },
    [submitTurn, photos, reportError],
  );

  // ── Dictation: the pill's mic toggles it, the transcript lands in the field ──
  const stt = useSpeechToText();
  useEffect(() => {
    if (stt.error) reportError(stt.error);
  }, [stt.error, reportError]);
  const sttRef = useRef(stt);
  sttRef.current = stt;
  const handleListeningChange = useCallback(async (listening: boolean) => {
    const current = sttRef.current;
    if (listening) {
      if (!current.isRecording && !current.isTranscribing) current.startRecording();
      return;
    }
    if (!current.isRecording) return;
    const text = await current.stopAndTranscribe();
    if (text) setInputValue((prev) => (prev ? `${prev} ${text}` : text));
  }, []);

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
  // A call that fails ends the same way a hang-up does, but the person is told why: a
  // button that silently does nothing reads as broken.
  const deactivateVoice = useCallback(
    (error?: string) => {
      setIsVoiceActive(false);
      setVoiceState(null);
      textSnapshotRef.current = [];
      if (error) reportError(error, labels.voiceFailed);
    },
    [reportError, labels.voiceFailed],
  );

  // ── TTS read aloud handler ──
  const handleReadAloud = useCallback(
    (messageId: string, text: string) => {
      tts.readAloud(messageId, text);
    },
    [tts],
  );

  // ── Mark state (drives the header brand mark) ──
  const voiceAgentState = voiceState?.agentState;
  const markState = useMemo<AliaAvatarState>(() => {
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
      <View className="flex-1 items-center justify-center px-4 py-10">
        <AliaWelcomeMessage greeting={welcomeGreeting} subtitle={welcomeSubtitle} />
      </View>
    );
  }, [welcomeGreeting, welcomeSubtitle, messages.length]);

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

  // The welcome and a call are the field's moments, so they get the intro's full strength; a
  // conversation being read keeps the hook's subtle one, so the text stays easy to read.
  const ambientIntensity = isVoiceActive || messages.length === 0 ? 1 : wave.intensity;

  // ── Voice activate button for empty submit (only if voice was provided) ──
  const voiceActivateButton = useMemo(
    () =>
      VoiceSession ? (
        <Button
          iconOnly
          tone="action"
          size="md"
          accessibilityLabel={labels.startVoice}
          onPress={activateVoice}
          leadingIcon={VoiceModeIcon}
        />
      ) : undefined,
    [VoiceSession, activateVoice, labels.startVoice],
  );

  const composer =
    VoiceSession && isVoiceActive ? (
      /* Suspense so the session may be handed to us as a React.lazy import. */
      <Suspense fallback={null}>
        <VoiceSession apiUrl={apiUrl} onStateChange={setVoiceState} onEnd={deactivateVoice} />
      </Suspense>
    ) : (
      <>
        <ComposerSuggestions
          completions={suggestions.completions}
          selected={suggestions.selected}
          onPick={handlePickSuggestion}
        />
        {/* Beside the loader, not inside the pill: its light traces the box it wraps. */}
        {asking ? (
          <View className="mb-2">
            <QuestionCard
              questions={questionsAsked}
              onSubmit={(message) => send(message)}
              onDismiss={() => setDismissedQuestionsOf(lastMessage?.id ?? null)}
            />
          </View>
        ) : null}
        <ComposerLoader active={isStreaming}>
          <ComposerPill
            onKeyPress={suggestions.onKeyPress}
            surface={false}
            frosted={isStreaming}
            value={inputValue}
            onValueChange={setInputValue}
            onSubmit={handleSubmit}
            busy={isStreaming}
            onStop={stop}
            emptyAction={voiceActivateButton}
            placeholder={labels.placeholder}
            addMenu={addMenuGroups}
            onAddMenuSelect={handleAddMenuSelect}
            attachments={photos.map((photo) => ({
              id: photo.id,
              name: photo.name,
              kind: 'image' as const,
              src: photo.uri,
            }))}
            onRemoveAttachment={(id) => setPhotos((prev) => prev.filter((p) => p.id !== id))}
            voiceState={
              stt.isTranscribing ? 'transcribing' : stt.isRecording ? 'recording' : 'idle'
            }
            onVoiceStateChange={(next) => void handleListeningChange(next === 'recording')}
          />
        </ComposerLoader>
      </>
    );

  return (
    <MarkStateContext.Provider value={markState}>
      <AiChatContainer
        project={title ?? undefined}
        projectIcon={BreadcrumbMark}
        header={typeof headerLeading === 'function' ? headerLeading(chatState) : headerLeading}
        actions={actions?.(chatState)}
        composer={
          bottomInset > 0 ? (
            <View style={{ paddingBottom: bottomInset }}>{composer}</View>
          ) : (
            composer
          )
        }
        // The thread scrolls behind the header and the composer, which fade in over it — as
        // in the app's conversation. The wave is the container's background layer, between
        // its surface and the turns.
        floatingChrome
        // The sheet or screen around it owns the fill and the shape; the container adds neither.
        surface={false}
        background={
          <AmbientField
            waveAmplitude={wave.waveAmplitude}
            agentState={wave.agentState}
            intensity={ambientIntensity}
            isDarkMode={isDarkMode}
          />
        }
      >
        <View style={styles.body}>
          {/* Welcome or Messages */}
          <AliaChatMessageList
            messages={messages}
            isStreaming={isStreaming}
            onReadAloud={handleReadAloud}
            ttsActiveMessageId={tts.activeMessageId}
            ttsPlaybackState={tts.playbackState}
            onEditMessage={onEditMessage}
            onThumbsUp={onThumbsUp}
            onThumbsDown={onThumbsDown}
            onApprovePlan={onApprovePlan}
            onRejectPlan={onRejectPlan}
            renderMarkdown={renderMarkdown}
            welcomeComponent={welcomeComponent}
          />
        </View>
      </AiChatContainer>
    </MarkStateContext.Provider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'relative',
  },
  body: {
    flex: 1,
  },
});

/** The chat: header, thread and composer, with the host's labels in reach of all of it. */
export function AliaChatContent({ labels, ...props }: AliaChatContentProps) {
  return (
    <AliaChatLabelsProvider labels={labels}>
      <AliaChatContentBody {...props} />
    </AliaChatLabelsProvider>
  );
}
