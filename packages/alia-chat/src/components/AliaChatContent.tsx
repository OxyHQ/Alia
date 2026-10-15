/**
 * Shared chat content component used by both AliaChatSheet and AliaChatScreen.
 *
 * Owns the text chat; voice is an injected capability (`voiceSession`) so that
 * nothing here reaches `livekit-client` at module-evaluation time. Containers
 * only handle layout chrome (sheet modal, full-screen SafeAreaView). The
 * breadcrumb header is Bloom's `AiChatContainer`, the one the app's conversation uses.
 */

import React, { Suspense, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { View } from 'react-native';
import { useAliaChat, type UseAliaChatOptions } from '../hooks/useAliaChat';
import { useTTS } from '../hooks/useTTS';
import { useSpeechToText } from '../hooks/useSpeechToText';
import { useImagePicker } from '../hooks/useImagePicker';
import { imageUriToDataUrl } from '../lib/image-data-url';
import { useAmbientWave } from '../hooks/useAmbientWave';
import { AmbientField } from './AmbientField';
import { QuestionCard } from './QuestionCard';
import { getAccountDisplayName } from '@oxy.so/core';
import { useOxy } from '@oxy.so/services/ui/client';
import { AgentAvatarProvider } from '@oxy.so/bloom/agent-avatar';
import { ALIA_CHARACTER_RUNTIME_URL } from '../lib/character-runtime';
import { pendingQuestions } from '../lib/questions';
import { AliaChatMessageList } from './AliaChatMessageList';
import { AliaFlightsProvider, ALIA_TO_PROFILE } from '../lib/flights';
import { AliaWelcomeMessage } from './AliaWelcomeMessage';
import { ComposerSuggestions } from './ComposerSuggestions';
import { useComposerSuggestions, useSuggestionQuery } from '../hooks/useComposerSuggestions';
import { ComposerLoader } from '@oxy.so/bloom/composer-loader';
import { AiChatContainer } from '@oxy.so/bloom/ai-chat';
import {
  AvatarFlightLayer,
  useAvatarFlights,
  type AvatarFlights,
} from '@oxy.so/bloom/avatar-flight';
import { ComposerPill, type ComposerPanelAddMenuGroup } from '@oxy.so/bloom/composer-panel';
import { RiImageLine } from '@oxy.so/bloom/icons';
import { toast } from '@oxy.so/bloom/toast';
import { Button } from '@oxy.so/bloom/button';
import { type AliaChatLabels, AliaChatLabelsProvider, useLabels } from '../lib/labels';
import type { AliaAvatarState } from './AliaAvatar';
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
  /** Its look, as the server stores it (JSON); absent, the default look. */
  character?: unknown;
}

/** What the chat tells its header and actions: whether there is a conversation to clear, and who took part. */
export interface AliaChatState {
  hasMessages: boolean;
  clear: () => void;
  /** What Alia is doing; the header's avatar shows it. */
  markState: AliaAvatarState;
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
  /** The empty chat's greeting; omitted, Alia greets the signed-in person by name (`labels`). */
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
  /**
   * The chat's top bar. Receives what it needs from the chat: whether there is anything to clear,
   * how, who took part, and what Alia is doing.
   */
  header?: (state: AliaChatState) => React.ReactNode;
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
  /** The agents the host knows, with their look: a delegation's thinking avatar is drawn from them. */
  agents?: UseAliaChatOptions['agents'];
  /**
   * The avatar flights this chat takes part in, when a sheet shares them across its chats (the
   * greeting's avatar flies into a header in another sheet). Omitted, the chat has its own.
   */
  flights?: AvatarFlights;
  /** A turn sent once as this chat mounts: the conversation a sheet was opened for. */
  initialTurn?: AliaTurn;
  /** Internal sheet lifecycle bridge: receives the live request canceller. */
  onStopReady?: (stop: (() => void) | null) => void;
  /** Overrides for the chat's own copy; anything omitted is English. */
  labels?: Partial<AliaChatLabels>;
  /** Where the 3D avatar's runtime is served from; omitted, Alia's shared copy (`ALIA_CHARACTER_RUNTIME_URL`). */
  characterRuntimeUrl?: string;
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
  header,
  isDarkMode,
  voiceSession: VoiceSession,
  bottomInset = 0,
  onStart,
  agents: knownAgents,
  flights: sharedFlights,
  initialTurn,
  onStopReady,
}: AliaChatContentProps) {
  const ownFlights = useAvatarFlights();
  const flights = sharedFlights ?? ownFlights;
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
  const chatOptions: UseAliaChatOptions = { apiUrl, model, clientContext, agents: knownAgents };
  const { messages, setMessages, send, isStreaming, stop, clear, approvePlan, rejectPlan } =
    useAliaChat(chatOptions);
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

  // The first turn of an empty chat goes to the host when it asked for it; every other turn is sent here.
  const startsElsewhere = onStart !== undefined && messages.length === 0;
  const firstTurn = messages.length === 0;
  const submitTurn = useCallback(
    async (text: string, images?: ReadonlyArray<string>) => {
      if (startsElsewhere) {
        // The host's conversation sheet opens first so that the flight, drawn when it launches,
        // is above it; this chat stays on the greeting, so the avatar can still be measured.
        onStart({ text, images });
        await flights.launch([ALIA_TO_PROFILE]);
        return;
      }
      // The greeting leaves with the first turn: measure it before it does.
      if (firstTurn) await flights.launch([ALIA_TO_PROFILE]);
      send(text, images ? { images } : undefined);
    },
    [startsElsewhere, onStart, firstTurn, flights, send],
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
  const [photos, setPhotos] = useState<
    Array<{ id: string; name: string; uri: string; mimeType?: string }>
  >([]);
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
          mimeType: asset.mimeType,
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
        const images = await Promise.all(
          pending.map((photo) => imageUriToDataUrl(photo.uri, photo.mimeType)),
        );
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

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const activateVoice = useCallback(() => {
    if (isVoiceActive) return;
    textSnapshotRef.current = [...messagesRef.current];
    setIsVoiceActive(true);
  }, [isVoiceActive]);

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
  const { readAloud } = tts;
  const handleReadAloud = useCallback(
    (messageId: string, text: string) => {
      readAloud(messageId, text);
    },
    [readAloud],
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

  const { user } = useOxy();
  const greeting =
    welcomeGreeting ?? (user ? labels.greetingNamed(getAccountDisplayName(user)) : labels.greeting);
  const welcomeComponent = useMemo(() => {
    if (messages.length > 0) return undefined;
    return (
      <View className="flex-1 items-center justify-center px-4 py-10">
        <AliaWelcomeMessage greeting={greeting} subtitle={welcomeSubtitle} />
      </View>
    );
  }, [greeting, welcomeSubtitle, messages.length]);

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

  const pillAttachments = useMemo(
    () =>
      photos.map((photo) => ({
        id: photo.id,
        name: photo.name,
        kind: 'image' as const,
        src: photo.uri,
      })),
    [photos],
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
            attachments={pillAttachments}
            onRemoveAttachment={(id) => setPhotos((prev) => prev.filter((p) => p.id !== id))}
            voiceState={
              stt.isTranscribing ? 'transcribing' : stt.isRecording ? 'recording' : 'idle'
            }
            onVoiceStateChange={(next) => void handleListeningChange(next === 'recording')}
          />
        </ComposerLoader>
      </>
    );

  const hasMessages = messages.length > 0;
  const headerNode = useMemo(
    () => header?.({ hasMessages, clear, markState, agents }),
    [header, hasMessages, clear, markState, agents],
  );
  const background = useMemo(
    () => (
      <AmbientField
        layout="sheet"
        waveAmplitude={wave.waveAmplitude}
        agentState={wave.agentState}
        intensity={ambientIntensity}
        isDarkMode={isDarkMode}
      />
    ),
    [wave.waveAmplitude, wave.agentState, ambientIntensity, isDarkMode],
  );

  return (
    <AliaFlightsProvider value={flights}>
      <AiChatContainer
        header={headerNode}
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
        background={background}
      >
        <View className="flex-1">
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
            onApprovePlan={onApprovePlan ?? approvePlan}
            onRejectPlan={onRejectPlan ?? rejectPlan}
            renderMarkdown={renderMarkdown}
            welcomeComponent={welcomeComponent}
          />
        </View>
      </AiChatContainer>
      {sharedFlights ? null : <AvatarFlightLayer flights={ownFlights} />}
    </AliaFlightsProvider>
  );
}

/** The chat: header, thread and composer, with the host's labels in reach of all of it. */
export function AliaChatContent({
  labels,
  characterRuntimeUrl = ALIA_CHARACTER_RUNTIME_URL,
  ...props
}: AliaChatContentProps) {
  return (
    <AgentAvatarProvider runtimeUrl={characterRuntimeUrl}>
      <AliaChatLabelsProvider labels={labels}>
        <AliaChatContentBody {...props} />
      </AliaChatLabelsProvider>
    </AgentAvatarProvider>
  );
}
