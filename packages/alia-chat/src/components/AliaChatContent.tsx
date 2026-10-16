/**
 * The conversation: header, thread and composer, with its voice call. The one screen of the
 * bottom sheet, `AliaChatScreen` and the Alia app — they are frames around this.
 *
 * It is the top of three layers, each depending only on the one before it: the runtime
 * (`useConversationThread`, the stream, the cache), the hooks that turn it into what a person does
 * (`useChatComposer`, `useChatVoice`, `useThreadView`), and this, which draws it — the thread
 * (`AliaThread`) and the agent's history behind it, the composer with its levels, suggestions and
 * questions, and the voice call: the button that opens it, the bar that replaces the composer, the
 * notices and the transcript in the thread. The call loads on the first call, so nothing here
 * reaches its audio engine at module-evaluation time.
 *
 * What a host brings is data and places: the conversation to show, the chrome around it
 * (`chrome`), its rows in the add menu, its words (`labels`), where the thought panel and a
 * scheduled task open (`runtime`), and a few gates (`voice`, `onSignInRequired`,
 * `renderUsageLimit`).
 */

import { getAccountDisplayName } from '@oxy.so/core';
import { useOxy } from '@oxy.so/services/ui/client';
import { AiChatContainer, type AiChatThreadHandle } from '@oxy.so/bloom/ai-chat';
import {
  AvatarFlightLayer,
  type AvatarFlights,
  useAvatarFlights,
} from '@oxy.so/bloom/avatar-flight';
import { Button } from '@oxy.so/bloom/button';
import { ScrollToBottomButton } from '@oxy.so/bloom/chat-screen';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';
import { useAmbientWave } from '../hooks/useAmbientWave';
import { useAtBottom } from '../hooks/useAtBottom';
import { type AliaTurn, useChatComposer } from '../hooks/useChatComposer';
import { type AliaVoiceOptions, useChatVoice } from '../hooks/useChatVoice';
import { usePendingQuestions } from '../hooks/usePendingQuestions';
import { usePhotosMenu } from '../hooks/usePhotosMenu';
import { useThreadView } from '../hooks/useThreadView';
import { useTTS } from '../hooks/useTTS';
import type { AliaAddMenu } from '../lib/add-menu';
import { AliaFlightsProvider } from '../lib/flights';
import { KeyboardSafeAreaFloor } from '../lib/keyboard';
import { type AliaChatLabels, AliaChatLabelsProvider, useLabels } from '../lib/labels';
import { type DeviceModel, buildPowerLevelOptions } from '../lib/power-level-options';
import { type AliaRuntimeHost, AliaRuntimeProvider, useAliaRuntime } from '../runtime/config';
import { useCreateConversation } from '../runtime/conversations';
import { aliaQueryKeys } from '../runtime/query-keys';
import type { Message } from '../runtime/types';
import { useAgentActivity } from '../runtime/use-agent-activity';
import { useConversationThread } from '../runtime/use-conversation-thread';
import { UsageLimitError } from '../runtime/usage-limit-error';
import type { AliaSuggestion } from '../types';
import type { AliaAvatarState } from './AliaAvatar';
import { AliaComposer } from './AliaComposer';
import { AliaWelcomeMessage } from './AliaWelcomeMessage';
import { AmbientField } from './AmbientField';
import { AliaThread } from './thread/AliaThread';
import { ThreadSearch } from './thread/ThreadSearch';
import { VoiceModeIcon } from './VoiceModeIcon';
import { AliaVoiceCall } from './voice/AliaVoiceCall';

/** The distinct delegated agents among `messages`, in the order they first answered. */
function participatingAgents(messages: readonly Message[]): AliaChatAgent[] {
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

/** What the chat tells its chrome: whether there is a conversation to act on, who took part, what Alia is doing. */
export interface AliaChatState {
  /** The conversation open, or `undefined` before the first turn creates one. */
  conversationId: string | undefined;
  hasMessages: boolean;
  /** Begin a new conversation. Nothing is deleted: the old one stays in the list. */
  startOver: () => void;
  /** Empty the open conversation, on the server and on screen. */
  clearMessages: () => Promise<unknown>;
  /** What Alia is doing; the header's avatar shows it. */
  markState: AliaAvatarState;
  /** The delegated agents that have answered, in the order they first did. */
  agents: AliaChatAgent[];
  /** Search what was said in the agent's thread. Present only on a thread (`threadHandle`). */
  openSearch: (() => void) | undefined;
  /** The conversation as it stands now, for an export. Read when called, not when rendered. */
  getMessages: () => readonly Message[];
}

/** What the container draws around the thread. */
export interface AliaChatChrome {
  /** The top bar. */
  header?: ReactNode;
  /** The crumb of the container's breadcrumb row. */
  title?: string;
  /** The project the chat is filed under, in the breadcrumb. */
  project?: string;
  /** The chat's own actions, at the end of the breadcrumb row. */
  actions?: ReactNode;
}

export interface AliaChatContentProps {
  // ── Which conversation ──
  /**
   * The conversation to show. Given, the host owns which one is open (a route) and learns of a new
   * one through `onConversationChange`; omitted, the chat keeps its own — unless the host
   * navigates (`runtime.openConversation`), which then decides: the chat starts empty and
   * creates its conversation with the first turn, or the first call.
   */
  conversationId?: string;
  /** The agent whose conversation this is; omitted, Alia's own. */
  agentId?: string;
  /**
   * The handle of the agent's permanent thread, when this conversation is the active stretch of
   * one: the conversations behind it are paged in above, and the thread can be searched. Omitted,
   * the chat is one conversation with nothing behind it.
   */
  threadHandle?: string;
  /** The chat opened a conversation (a new one, from a first turn or a call) or left it (`undefined`). */
  onConversationChange?: (conversationId: string | undefined) => void;
  /** The host's side of the conversation runtime: navigation, artifacts, credits… */
  runtime?: AliaRuntimeHost;
  /**
   * Nothing is stored: the first turn is sent without creating a conversation, so the whole chat
   * lives on this screen (ghost mode).
   */
  ephemeral?: boolean;
  apiUrl?: string;
  /** App context injected into the system prompt. */
  clientContext?: string;
  // ── The power level ──
  /**
   * The power level (`auto`, `instant`, `medium`, `high`, `xhigh`, `pro`, `ultra`) or exact
   * `publisher/model` every turn is sent with; omitted, the server's default.
   */
  model?: string;
  /** Makes the level selectable in the composer: the person picked `model`. Omitted, no selector. */
  onModelChange?: (model: string) => void;
  /** Models on the person's own devices, offered after the levels in the selector. */
  deviceModels?: readonly DeviceModel[];
  // ── Words ──
  /** Overrides for the chat's own copy; anything omitted is English. */
  labels?: Partial<AliaChatLabels>;
  /** The empty chat's greeting; omitted, Alia greets the signed-in person by name (`labels`). */
  welcomeGreeting?: string;
  welcomeSubtitle?: string;
  /** The lines offered over the composer on an empty chat. */
  welcomeSuggestions?: AliaSuggestion[];
  /** What the host found for the typed text (see `onSuggestionQuery`). */
  suggestionMatches?: AliaSuggestion[];
  /** The typed text, once typing has settled, for the host to search suggestions with. */
  onSuggestionQuery?: (query: string) => void;
  /** A suggestion was picked (before it is sent, or put in the composer if it is a template). */
  onSuggestionPicked?: (suggestion: AliaSuggestion) => void;
  // ── The frame ──
  /**
   * What the container draws around the thread, from what the chat knows (who took part, whether
   * there is anything to clear, whether it is a searchable thread).
   */
  chrome?: (state: AliaChatState) => AliaChatChrome;
  /** The container draws its own surface (the card of a page), instead of leaving the fill to the frame around it. */
  surface?: boolean;
  /** Dark-mode flag — forwarded to the ambient wave overlay. */
  isDarkMode?: boolean;
  /** The ambient field's shape: the whole `screen` (default) or a `sheet`'s smaller one. */
  layout?: 'screen' | 'sheet';
  /**
   * Whether the screen holding the chat is the one on show. A screen kept mounted under another
   * pauses its ambient field, and a live call ends when it is not. Default `true`.
   */
  isFocused?: boolean;
  /**
   * Space the composer keeps clear at the bottom edge, in px — the home indicator, when the chat
   * is flush with the screen. It gives way to the keyboard. The ambient background still runs
   * behind it.
   */
  bottomInset?: number;
  // ── The composer ──
  /** The host's rows in the add menu. Omitted, the menu offers photos. */
  addMenu?: AliaAddMenu;
  /** The tab on the composer's top edge (the project the chat is filed under). Replaced by the edit strip while a question is rewritten. */
  composerStatus?: ReactNode;
  /** Error handler (e.g. toast) */
  onError?: (message: string) => void;
  /**
   * The person is signed out and sent a turn: the host asks them to sign in. The draft stays in
   * the composer. Omitted, the turn is sent and the server's refusal is told.
   */
  onSignInRequired?: () => void;
  /**
   * The turn was refused for the person's usage limit: the composer is closed until `dismiss`,
   * and this draws what the host says about it (a dialog).
   */
  renderUsageLimit?: (limit: { error: UsageLimitError; dismiss: () => void }) => ReactNode;
  /**
   * The chat's voice call. On by default; `false` makes the chat text-only. An object brings
   * what only the host knows: the gate before a call (`canStartVoice`, `onVoiceBlocked`), what
   * to refresh when one ends (`onCallEnded`), where its notices go (`onNotice`), the sounds it
   * plays. The call always lives in the chat's conversation, made when it starts if the chat has
   * none.
   */
  voice?: false | AliaVoiceOptions;
  // ── The sheet's ──
  /**
   * Hands the first turn of an empty chat to the host instead of sending it here — a sheet opens
   * the conversation in a new sheet over this one. Omitted, the chat sends it itself.
   */
  onStart?: (turn: AliaTurn) => void;
  /**
   * The avatar flights this chat takes part in, when a sheet shares them across its chats (the
   * greeting's avatar flies into a header in another sheet). Omitted, the chat has its own.
   */
  flights?: AvatarFlights;
  /** A turn sent once as this chat mounts: the conversation a sheet was opened for. */
  initialTurn?: AliaTurn;
  /**
   * The `animatedProgress` of the Bloom sheet this chat is in. The composer takes focus (and on
   * native opens the keyboard) once it reads `1`, so the person can type as soon as the sheet is
   * up. Omitted, the chat is not in a sheet and focus is left alone.
   */
  presentedProgress?: SharedValue<number>;
  /** Internal sheet lifecycle bridge: receives the live request canceller. */
  onStopReady?: (stop: (() => void) | null) => void;
}

/** The chat API carries photos (`image_url` parts) and nothing else. */
const PHOTOS_ONLY = ['image'] as const;

/** No live conversation while the thread looks at a moment of its past, as ONE array. */
const NO_MESSAGES: Message[] = [];

/** The conversation view: everything of `AliaChatContentProps` that is not about which conversation is open. */
type ConversationViewProps = Omit<
  AliaChatContentProps,
  'labels' | 'onConversationChange' | 'runtime' | 'conversationId' | 'apiUrl'
> & { conversationId: string | undefined };

function AliaConversationView({
  clientContext,
  model,
  onModelChange,
  deviceModels,
  conversationId,
  agentId,
  threadHandle,
  ephemeral = false,
  onError,
  welcomeGreeting,
  welcomeSubtitle,
  welcomeSuggestions,
  suggestionMatches,
  onSuggestionQuery,
  onSuggestionPicked,
  chrome,
  surface = false,
  isDarkMode,
  layout = 'screen',
  isFocused = true,
  bottomInset = 0,
  addMenu,
  composerStatus,
  onSignInRequired,
  renderUsageLimit,
  voice: voiceOptions,
  onStart,
  flights: sharedFlights,
  initialTurn,
  presentedProgress,
  onStopReady,
}: ConversationViewProps) {
  const ownFlights = useAvatarFlights();
  const flights = sharedFlights ?? ownFlights;
  const labels = useLabels();
  const { t } = labels;
  const runtime = useAliaRuntime();
  const queryClient = useQueryClient();
  const { user, isAuthenticated } = useOxy();

  // A failure reaches the host's handler when it has one, and Bloom's toast otherwise.
  const reportError = useCallback(
    (message: string, title?: string) => {
      if (onError) onError(title ? `${title}: ${message}` : message);
      else toast.error(title ?? message, title ? { description: message } : undefined);
    },
    [onError],
  );

  // ── The conversation ──
  const thread = useConversationThread({ conversationId, agentId, model, clientContext });
  const {
    messages,
    setMessages,
    isLoading,
    conversationLoading,
    error,
    clearError,
    stopGeneration: stop,
    startOver,
    clearConversation,
    approvePlan,
    rejectPlan,
    suggestedNewConversation,
    dismissSuggestedNewConversation,
    agentRun,
    failedTurn,
    retryFailedTurn,
  } = thread;
  const agents = useMemo(() => participatingAgents(messages), [messages]);
  const asked = usePendingQuestions(messages, isLoading);
  const view = useThreadView(threadHandle, conversationId);
  const agentActivity = useAgentActivity(agentRun?.turnId ?? null, agentRun?.agentId);

  // The turn was refused for the usage limit: the composer is closed until the host's dialog is
  // dismissed. Name as well as class — Hermes can break `instanceof` for Error subclasses.
  const usageLimit =
    error instanceof UsageLimitError || error?.name === 'UsageLimitError'
      ? (error as UsageLimitError)
      : null;
  const closed = usageLimit !== null;

  useEffect(() => {
    onStopReady?.(stop);
    return () => onStopReady?.(null);
  }, [onStopReady, stop]);

  // ── What the person does: write, send, rewrite, call ──
  const composer = useChatComposer({
    conversationId,
    thread,
    ephemeral,
    closed,
    onWrite: view.backToLatest,
    onStart,
    flights,
    initialTurn,
    onSignInRequired,
    reportError,
    welcomeSuggestions,
    suggestionMatches,
    onSuggestionQuery,
    onSuggestionPicked,
    presentedProgress,
  });
  const voice = useChatVoice({
    options: voiceOptions,
    conversationId,
    agentId,
    isFocused,
    ensureConversation: thread.ensureConversation,
    messages,
    setMessages,
    storedMessages: thread.conversation?.messages,
    isLoading,
  });
  const photosMenu = usePhotosMenu(composer.address);
  const menu = addMenu ?? photosMenu;
  const modes = useMemo(
    () => (onModelChange ? buildPowerLevelOptions(t, deviceModels ?? []) : undefined),
    [onModelChange, t, deviceModels],
  );

  // ── The way back to the newest turn ──
  const threadRef = useRef<AiChatThreadHandle | null>(null);
  const { isAtBottom, onScroll } = useAtBottom();
  const jumpToEnd = useCallback(() => threadRef.current?.scrollToEnd({ animated: false }), []);

  // ── The ambient wave — one persistent overlay across idle, voice, read-aloud and dictation ──
  const tts = useTTS({ apiUrl: runtime.apiUrl, ...runtime.speech });
  const { state: voiceState } = voice;
  const wave = useAmbientWave({
    voice: voiceState
      ? {
          isActive: voice.isActive,
          isConnected: voiceState.isConnected,
          agentState: voiceState.agentState,
          waveAmplitude: voiceState.waveAmplitude,
        }
      : undefined,
    isTTSPlaying: tts.playbackState === 'playing',
    ttsWaveAmplitude: tts.ttsWaveAmplitude,
    isGenerating: isLoading,
  });
  // The welcome and a call are the field's moments, so they get the intro's full strength; a
  // conversation being read keeps the hook's subtle one, so the text stays easy to read.
  const ambientIntensity = voice.isActive || composer.firstTurn ? 1 : wave.intensity;
  const background = useMemo(
    () => (
      <AmbientField
        layout={layout}
        waveAmplitude={wave.waveAmplitude}
        agentState={wave.agentState}
        intensity={ambientIntensity}
        isDarkMode={isDarkMode}
        // A screen kept mounted under another does not keep animating back there.
        paused={!isFocused}
      />
    ),
    [layout, wave.waveAmplitude, wave.agentState, ambientIntensity, isDarkMode, isFocused],
  );

  // ── The greeting of an empty chat ──
  const greeting =
    welcomeGreeting ??
    (isAuthenticated && user
      ? labels.greetingNamed(getAccountDisplayName(user, labels.locale))
      : labels.greeting);
  const welcome = useMemo(
    () => <AliaWelcomeMessage greeting={greeting} subtitle={welcomeSubtitle} />,
    [greeting, welcomeSubtitle],
  );

  // ── The agent's offer to start the next stretch fresh ──
  const createConversation = useCreateConversation();
  /**
   * Take the agent up on its offer: start the next stretch of this thread.
   *
   * The agent cannot do this — its tool emits one frame and writes nothing — so the act is the
   * person's, here. A new conversation with the same agent becomes the most recent, which is the
   * one the thread calls active, so re-reading the thread is what moves the screen onto it. On a
   * chat that is not a thread there is nothing to continue: the offer empties the chat, which is
   * "start a new conversation" on a screen that has no thread.
   */
  const acceptNewConversation = useCallback(() => {
    dismissSuggestedNewConversation();
    if (agentId === undefined || threadHandle === undefined) {
      void startOver();
      return;
    }
    createConversation.mutate(
      { agentId },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: aliaQueryKeys.threads.all(threadHandle) });
          // And the history with it: the stretch that was live becomes history the moment a new
          // one is active, and the pages held were fetched before its last turns existed.
          void queryClient.invalidateQueries({
            queryKey: aliaQueryKeys.threads.messages(threadHandle),
          });
        },
      },
    );
  }, [
    agentId,
    threadHandle,
    createConversation,
    queryClient,
    dismissSuggestedNewConversation,
    startOver,
  ]);
  const newConversationOffer = useMemo(
    () =>
      suggestedNewConversation === null
        ? undefined
        : {
            reason: suggestedNewConversation,
            onAccept: acceptNewConversation,
            onDismiss: dismissSuggestedNewConversation,
          },
    [suggestedNewConversation, acceptNewConversation, dismissSuggestedNewConversation],
  );

  // ── The chrome ──
  const latestMessages = useRef(messages);
  latestMessages.current = messages;
  const hasMessages = messages.length > 0;
  const state = useMemo<AliaChatState>(
    () => ({
      conversationId,
      hasMessages,
      startOver,
      clearMessages: clearConversation,
      markState: voice.markState,
      agents,
      openSearch: threadHandle === undefined ? undefined : view.openSearch,
      getMessages: () => latestMessages.current,
    }),
    [
      conversationId,
      hasMessages,
      startOver,
      clearConversation,
      voice.markState,
      agents,
      threadHandle,
      view.openSearch,
    ],
  );
  const frame = useMemo(() => chrome?.(state) ?? {}, [chrome, state]);

  // ── The composer ──
  const { editing, edit } = composer;
  const voiceButton = voice.enabled ? (
    <Button
      iconOnly
      tone="action"
      size="md"
      accessibilityLabel={labels.startVoice}
      onPress={voice.activate}
      leadingIcon={VoiceModeIcon}
    />
  ) : undefined;
  const status: ReactNode =
    editing !== undefined ? (
      // What is happening while a question is rewritten, and the way out of it. Drawn as the
      // status tab it replaces: the thread scrolls behind the composer, and a strip without the
      // tab's surface printed its words over the transcript's.
      <View className="mx-7 h-[34px] flex-row items-center gap-2 rounded-t-2xl bg-background-tertiary-default px-2 py-1">
        <RiEditLine size="sm" />
        <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>
          {t('composer.editingMessage')}
        </Text>
        <Button appearance="subtle" tone="accent" size="xs" onPress={edit.cancel}>
          {t('composer.cancelEdit')}
        </Button>
      </View>
    ) : (
      composerStatus
    );

  const composerNode = (
    <>
      {voice.enabled && voice.isActive ? (
        <AliaVoiceCall {...voice.launcher.sessionProps} />
      ) : (
        <AliaComposer
          // A different account is a different composer: reads in flight for the last one are
          // aborted rather than landing here.
          key={composer.address.account ?? ''}
          apiUrl={runtime.apiUrl}
          speechLanguage={runtime.speech.language}
          inputRef={composer.inputRef}
          disableKeyboardAvoidance
          onKeyPress={composer.onKeyPress}
          suggestions={composer.suggestions}
          // Asked beside the field, not in the thread: the card docks above the composer.
          questions={{
            items: asked.questions,
            onSubmit: (message) => void composer.sendTurn(message, undefined, composer.turnOptions),
            onDismiss: asked.dismiss,
          }}
          value={composer.text}
          onValueChange={composer.setText}
          onSubmit={() => void composer.submit(composer.text)}
          busy={isLoading}
          disabled={closed}
          onStop={stop}
          emptyAction={voiceButton}
          accessory={
            <ScrollToBottomButton
              visible={!isAtBottom}
              onPress={jumpToEnd}
              accessibilityLabel={t('chat.bloom.scrollToLatest')}
            />
          }
          placeholder={
            closed
              ? t('usageLimit.inputDisabledPlaceholder')
              : editing !== undefined
                ? t('composer.editPlaceholder')
                : labels.placeholder
          }
          status={status}
          // The mode selector is the power level: how much power this turn gets.
          {...(modes === undefined
            ? {}
            : { modes, mode: model ?? 'auto', onModeChange: onModelChange })}
          addMenu={menu.groups}
          onAddMenuSelect={menu.onSelect}
          attachments={composer.photos}
          onAddAttachment={composer.addAttachment}
          onRemoveAttachment={composer.removeAttachment}
          attachmentKinds={addMenu === undefined ? PHOTOS_ONLY : undefined}
          onError={onError}
        />
      )}
      {bottomInset > 0 ? <KeyboardSafeAreaFloor inset={bottomInset} /> : null}
    </>
  );

  const showsPast = view.jumped;
  return (
    <AliaFlightsProvider value={flights}>
      <AiChatContainer
        header={frame.header}
        title={frame.title}
        project={frame.project}
        actions={frame.actions}
        composer={composerNode}
        // The thread scrolls behind the header and the composer, which fade in over it. The wave
        // is the container's background layer, between its surface and the turns.
        floatingChrome
        // A frame that owns the fill and the shape (a sheet, a screen) leaves the surface off.
        surface={surface}
        background={background}
      >
        <AliaThread
          // Nothing live under a window: it is a view of the past, and the conversation being
          // streamed into is not below it in the thread.
          messages={showsPast ? NO_MESSAGES : messages}
          conversationId={conversationId}
          isLoading={isLoading}
          conversationLoading={conversationLoading}
          history={view.history}
          focusCursor={view.focusCursor}
          failedTurn={failedTurn}
          onRetryTurn={retryFailedTurn}
          onRegenerate={composer.regenerate}
          onStartEdit={edit.start}
          onApprovePlan={approvePlan}
          onRejectPlan={rejectPlan}
          newConversationOffer={newConversationOffer}
          agentActivity={agentRun === null ? null : agentActivity}
          call={voice.isActive ? { agentState: voice.agentState } : undefined}
          empty={welcome}
          threadRef={threadRef}
          onScroll={onScroll}
        />
        {!showsPast ? null : (
          <View className="absolute inset-x-0 top-16 z-10 items-center" pointerEvents="box-none">
            <Button appearance="outline" tone="neutral" size="sm" onPress={view.backToLatest}>
              {t('chat.backToLatest')}
            </Button>
          </View>
        )}
        {!view.searchOpen || threadHandle === undefined ? null : (
          <ThreadSearch handle={threadHandle} onJump={view.jump} onClose={view.closeSearch} />
        )}
      </AiChatContainer>
      {usageLimit === null ? null : renderUsageLimit?.({ error: usageLimit, dismiss: clearError })}
      {sharedFlights ? null : <AvatarFlightLayer flights={ownFlights} />}
    </AliaFlightsProvider>
  );
}

/**
 * The chat: header, thread and composer, with the host's labels in reach of all of it.
 *
 * It is a conversation view over the shared runtime. The conversation open in it is the host's
 * when `conversationId` is given, and its own otherwise.
 */
export function AliaChatContent({
  labels,
  conversationId: controlledId,
  onConversationChange,
  runtime,
  apiUrl,
  ...props
}: AliaChatContentProps) {
  const [ownId, setOwnId] = useState<string | undefined>(undefined);
  const parent = useAliaRuntime();
  // Who decides which conversation is open: a host that navigates (a route) does; with none, the
  // chat does (the sheet). Either way the host hears of it first, then `onConversationChange`.
  const hostOpens = runtime?.openConversation ?? parent.host.openConversation;
  const hostCloses = runtime?.closeConversation ?? parent.host.closeConversation;
  const hostNavigates = hostOpens !== undefined;
  const host = useMemo<AliaRuntimeHost>(
    () => ({
      ...runtime,
      openConversation: (id) => {
        hostOpens?.(id);
        if (!hostNavigates) setOwnId(id);
        onConversationChange?.(id);
      },
      closeConversation: () => {
        hostCloses?.();
        if (!hostNavigates) setOwnId(undefined);
        onConversationChange?.(undefined);
      },
    }),
    [runtime, hostOpens, hostCloses, hostNavigates, onConversationChange],
  );

  return (
    <AliaChatLabelsProvider labels={labels}>
      <AliaRuntimeProvider apiUrl={apiUrl ?? parent.apiUrl} host={host}>
        <AliaConversationView {...props} conversationId={controlledId ?? ownId} />
      </AliaRuntimeProvider>
    </AliaChatLabelsProvider>
  );
}
