import { ChatInterface } from '@/features/chat/ui/chat-interface';
import { ChatWorkspace } from '@/features/chat/ui/chat-workspace';
import type { WelcomeIntroSlots } from '@/features/chat/ui/welcome-intro';
import { Composer } from '@/features/chat/ui/composer/composer';
import { useAliaComposer } from '@/features/chat/ui/composer/use-alia-composer';
import {
  ComposerSuggestions,
  useComposerSuggestions,
} from '@/features/chat/ui/composer/composer-suggestions';
import { useCreditWarnings } from '@/features/chat/runtime/use-credit-warnings';
import { useLocalModelsInvite } from '@/features/chat/runtime/use-local-models-invite';
import { useEntitlements } from '@/features/billing/runtime/use-billing';
import { useCredits } from '@/features/billing/runtime/use-credits';
import {
  useRecordSuggestionUsage,
  type Suggestion,
} from '@/features/chat/runtime/use-suggestions';
import { Button } from '@oxy.so/bloom/button';
import { useTheme } from '@oxy.so/bloom/theme';
import { VoiceModeIcon } from '@/features/voice/ui/voice-mode-icon';
import { toast } from '@oxy.so/bloom/toast';
import { useRouter } from 'expo-router';
import { useScreenOnShow } from '@/shared/platform/use-screen-on-show';
import type { Attachment } from '@/features/chat/ui/composer/types';
import type { AgentActivityState } from '@/features/chat/runtime/use-agent-activity';
import type { FailedTurn } from '@/features/chat/runtime/use-streaming-chat';
import type { SendOptions } from '@/shared/contracts/chat-turn';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { useVoiceMode } from '@/features/voice/runtime/use-voice-mode';
import { useStore } from '@/features/chat/runtime/global-store';
import { useTurnEdit } from '@/features/chat/runtime/use-turn-edit';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { Text } from '@oxy.so/bloom/typography';
import { useFoldersStore } from '@/features/projects/runtime/folders-store';
import { useProjectsStore } from '@/features/projects/runtime/projects-store';
import type { ThreadMessage } from '@/features/chat/model/thread-history';
import { useColorScheme } from '@/shared/platform/useColorScheme';
import type { Message } from '@/features/chat/model/chat';
import { AmbientField } from '@/features/chat/ui/ambient-field';
import { useTTS } from '@/features/voice/runtime/use-tts';
import { VoiceControls, useAmbientWave } from '@alia.onl/sdk/voice';
import {
  AiChatMobileHeader,
  type AiChatThreadHandle,
} from '@oxy.so/bloom/ai-chat';
import { ComposerPanelStatusTab } from '@oxy.so/bloom/composer-panel';
import { useAuth } from '@oxy.so/services';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ScrollToBottomButton } from '@oxy.so/bloom/chat-screen';
import { useAtBottom } from '@/features/chat/runtime/use-at-bottom';
import { View, type NativeSyntheticEvent, type TextInput, type TextInputKeyPressEventData } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardSafeAreaFloor } from '@/shared/platform/keyboard';

/**
 * Where the composer's capabilities live now.
 *
 * ## Three were removed because they reached nothing
 *
 * The menu once offered six. Three of them wrote to a local `Set` and stopped
 * there:
 *
 *  - **Web search** — no `webSearch` field existed on the request and no
 *    backend read one. It was meaningless in BOTH directions at once: it could
 *    not enable searching, because `lib/tool-pipeline.ts` put `webSearch`,
 *    `webScraper` and `browse` in the always-on tool set, and it could not
 *    disable it, because nothing was sent. It is real now and lives on the
 *    model store beside the other two composer axes — the flag is what
 *    WITHHOLDS those three tools.
 *  - **Study and learn** — no flag, no handler, no prompt. Removed.
 *  - **Shopping research** — no flag and no handler either, though
 *    `seed-features.ts` sells `shopping-research` as a plan feature on Go, Pro,
 *    Max and Ultra. Removed from the composer; the entitlement is a product
 *    decision recorded in the PR rather than something a menu should keep
 *    pretending about.
 *
 * ## And the local `Set` is gone too
 *
 * The three that remained — ghost, agent and deep research — were owned twice:
 * by that `Set`, which drew the checkmarks, and by the global store, which is
 * what `use-streaming-chat.ts` reads at send time. A remount emptied the `Set`
 * and left the store alone, so the two disagreed and the payload won silently.
 * `useCapabilityModes` is the single owner now; see its file for the whole of
 * that story. This component only renders what it reports.
 *
 * ## And the menu is data now
 *
 * The rows were a `DropdownMenu` tree spelled out here — a `CheckboxItem` per
 * mode, a `Separator` and a `Label` per section, an icon component for a
 * connector's artwork. Bloom's add menu takes
 * `ComposerPanelAddMenuGroup[]` and reports the pressed row's id, so all of it
 * became a list built in `src/features/chat/ui/composer/add-menu.tsx`, and this
 * component supplies the state and the handlers rather than the markup. What
 * stays here is what was always this file's: which axes exist, what toggling
 * one MEANS, and the toast that says it happened.
 */

type VoiceState = ReturnType<typeof useVoiceMode>;

interface ChatPageContentProps {
  messages: Message[];
  isLoading: boolean;
  onSubmit: (
    value: string,
    attachments?: Attachment[],
    options?: SendOptions,
  ) => Promise<boolean>;
  onStop?: () => void;
  /**
   * Send a rewritten question in place of the one sent: the thread is cut back
   * to it. `attachments` are the ones added while editing; the turn keeps its
   * own. Absent where the screen cannot edit.
   */
  onEditMessage?: (
    messageId: string,
    text: string,
    options?: SendOptions,
    attachments?: Attachment[],
  ) => Promise<boolean>;
  /** Ask for a reply again; `fallback` is used when its question's options are unknown. */
  onRegenerateMessage?: (assistantMessageId: string, fallback?: SendOptions) => Promise<boolean>;
  /** The options a question was sent with, when this screen sent it. */
  turnOptionsOf?: (userMessageId: string) => SendOptions | undefined;
  disabled?: boolean;
  conversationLoading?: boolean;
  voice?: VoiceState;
  agentActivity?: AgentActivityState | null;
  /** The agent this thread belongs to, for the title when the chat has none. */
  agentName?: string;
  agentSessionId?: string | null;
  onApprovePlan?: (planId: string) => void;
  onRejectPlan?: (planId: string) => void;
  /** The agent's offer to start a fresh stretch, and the two answers to it. */
  suggestedNewConversation?: string | null;
  onAcceptNewConversation?: () => void;
  onDismissNewConversation?: () => void;
  /**
   * The chat this screen is showing, or omitted for the new-chat screen. The
   * drawer keeps every visited chat mounted, so this is what names the draft
   * this screen's composer edits.
   */
  conversationId?: string;
  conversationTitle?: string;
  /**
   * The thread's history and how to ask for more of it.
   *
   * All four are absent on `/c/:id`: a chat in the sidebar is one conversation
   * with nothing behind it, so there is no older stretch to page into.
   */
  historyMessages?: ThreadMessage[];
  hasMoreHistory?: boolean;
  isLoadingHistory?: boolean;
  onLoadHistory?: () => void;
  /** The message a jump was aimed at, by cursor, or `null` at the present. */
  focusCursor?: string | null;
  /**
   * The turn that got no answer, drawn in the thread with an error and a
   * retry, or `null`. Both are passed straight through to the list.
   */
  failedTurn?: FailedTurn | null;
  onRetryTurn?: () => void;
  /** Start voice mode where this screen has no voice session of its own (the new-chat screen). */
  onVoiceStart?: () => void;
  /** The model this chat sends with (a conversation remembers its own). */
  selectedModel?: string | null;
  onModelChange?: (model: string | null) => void;
  /**
   * The signed-out welcome, in place of the conversation: its field in the
   * container's background slot and its words in the content area, with no
   * composer until it is answered.
   */
  intro?: WelcomeIntroSlots;
  /**
   * The chat's own actions for the container's breadcrumb row (export,
   * search, delete). Absent on the new-chat screen: there is nothing
   * persisted to act on yet.
   */
  headerActions?: React.ReactNode;
}

export const ChatPageContent = ({
  messages,
  isLoading,
  onSubmit,
  onStop,
  onEditMessage,
  onRegenerateMessage,
  turnOptionsOf,
  disabled = false,
  conversationLoading,
  voice,
  agentActivity,
  agentName,
  agentSessionId,
  onApprovePlan,
  onRejectPlan,
  suggestedNewConversation,
  onAcceptNewConversation,
  onDismissNewConversation,
  conversationId,
  conversationTitle,
  historyMessages,
  hasMoreHistory = false,
  isLoadingHistory = false,
  onLoadHistory,
  focusCursor,
  failedTurn,
  onRetryTurn,
  selectedModel,
  onModelChange,
  onVoiceStart,
  intro,
  headerActions,
}: ChatPageContentProps) => {
  const { isAuthenticated, signIn } = useAuth();
  const { t } = useTranslation();
  const isMainScreen = messages.length === 0;
  // The same composer every screen that asks Alia something uses.
  // This screen's draft: its conversation, or the new-chat screen's own.
  const composer = useAliaComposer({
    draft: conversationId ?? null,
    locked: isLoading || disabled,
    offerGhost: isMainScreen,
    selectedModel,
    onModelChange,
  });
  const { attachments, turnOptions, clearDraft } = composer;
  // A question being rewritten in this composer, if one is (`useTurnEdit`).
  const edit = useTurnEdit({
    target: conversationId ?? null,
    messages,
    turnOptionsOf,
    onEditMessage,
  });
  const { editing } = edit;
  /**
   * Starting an edit puts the caret in the composer that now holds the
   * question: the Edit press left focus on the row's button, so typing went
   * nowhere and Escape could not reach the edit it should cancel.
   */
  const composerInputRef = useRef<TextInput | null>(null);
  const editingId = editing?.messageId;
  useEffect(() => {
    if (editingId !== undefined) composerInputRef.current?.focus();
  }, [editingId]);

  // Toasts that belong to the chat, never to "Meet Alia" in front of it.
  useLocalModelsInvite(intro === undefined);
  useCreditWarnings(intro === undefined);

  const isVoiceActive = voice?.isVoiceActive ?? false;
  // The text is the draft's too: a draft handed over by another route, or
  // handed back by a send that failed, is simply there.
  const inputValue = composer.text;
  const setInputValue = composer.setText;

  const { colors, isDarkColorScheme } = useColorScheme();
  const theme = useTheme();
  const { ttsWaveAmplitude, playbackState: ttsPlaybackState } = useTTS();
  // The ambient field behind the conversation, the welcome's own: one wave
  // across idle, voice, read-aloud and dictation (STT is read inside
  // useAmbientWave from the SDK store).
  const wave = useAmbientWave({
    voice: voice
      ? {
          isActive: voice.isVoiceActive,
          isConnected: voice.isConnected,
          agentState: voice.agentState,
          waveAmplitude: voice.waveAmplitude,
        }
      : undefined,
    isTTSPlaying: ttsPlaybackState === 'playing',
    ttsWaveAmplitude,
    isGenerating: isLoading,
  });
  const insets = useSafeAreaInsets();
  const onShow = useScreenOnShow();
  /**
   * Where the sidebar's tree files the chat: its project, its folder, or
   * the tree itself ("Chats"). It is the breadcrumb's crumb and the
   * composer's status tab.
   */
  const projects = useProjectsStore((state) => state.projects);
  const folders = useFoldersStore((state) => state.folders);
  const projectName = conversationId
    ? (projects.find((p) => p.conversationIds.includes(conversationId))?.name ??
      folders.find((f) => f.conversationIds.includes(conversationId))?.name ??
      t('sidebar.chats'))
    : undefined;

  /**
   * Ask for the page above, unless there is nothing above or one is already
   * coming.
   *
   * Bloom fires `onStartReached` once per approach and re-arms when the reader
   * leaves the zone, so the only guards left here are about the DATA: a thread
   * with no older stretch, and a request already in flight.
   */
  const handleLoadHistory = useCallback(() => {
    if (onLoadHistory === undefined || !hasMoreHistory || isLoadingHistory)
      return;
    onLoadHistory();
  }, [onLoadHistory, hasMoreHistory, isLoadingHistory]);

  const threadRef = useRef<AiChatThreadHandle | null>(null);
  /**
   * Whether the reader has left the end, for Bloom's jump to the newest turn.
   * The button rides the composer, which stays pinned while the page scrolls.
   */
  const { isAtBottom, onScroll: onThreadScroll } = useAtBottom();
  const jumpToEnd = useCallback(() => threadRef.current?.scrollToEnd({ animated: false }), []);

  /**
   * Voice mode, from the send slot while the composer is empty — as it was
   * before the composer became Bloom's panel. It needs an account, a plan
   * with voice, and credits.
   */
  const { data: entitlements } = useEntitlements();
  const { data: creditsInfo } = useCredits();
  const router = useRouter();
  const handleVoiceActivate = useCallback(() => {
    if (!isAuthenticated) {
      signIn().catch(() => {});
      return;
    }
    if (!entitlements?.features['voice-mode']) {
      toast.info(t('subscribe.featureRequiresPlan', { feature: t('modes.voiceMode') }));
      router.push('/(biglayout)/subscribe');
      return;
    }
    if (creditsInfo && creditsInfo.credits <= 0) {
      toast.error(t('usageLimit.outOfCreditsTitle'));
      return;
    }
    if (voice) voice.activateVoice();
    else onVoiceStart?.();
  }, [isAuthenticated, signIn, entitlements, creditsInfo, t, router, voice, onVoiceStart]);
  /** The call bar's words, in the app's language. */
  const voiceControlLabels = useMemo(
    () => ({
      connecting: t('voice.controls.connecting'),
      connected: t('voice.controls.connected'),
      listening: t('voice.controls.listening'),
      muted: t('voice.controls.muted'),
      thinking: t('voice.controls.thinking'),
      speaking: t('voice.controls.speaking'),
      mute: t('voice.controls.mute'),
      unmute: t('voice.controls.unmute'),
      end: t('voice.controls.end'),
    }),
    [t],
  );
  const voiceAction =
    voice || onVoiceStart ? (
      // Alia's voice button: its own glyph (as it has always been), in the
      // composer's action tone.
      <Button
        iconOnly
        size="md"
        tone="action"
        leadingIcon={VoiceModeIcon}
        accessibilityLabel={t('modes.voiceMode')}
        onPress={handleVoiceActivate}
      />
    ) : undefined;

  useEffect(() => {
    useStore.getState().setGhostMode(false);
  }, []);

  /**
   * Read through a ref: the handler is a prop of the thread's last reply, and
   * the send path's identity changes with every streamed token.
   */
  const latest = useRef({ onRegenerateMessage, turnOptions });
  latest.current = { onRegenerateMessage, turnOptions };

  /** A reply again, sent the way its question was (the composer's choice if unknown). */
  const handleRegenerate = useCallback((assistantMessageId: string) => {
    const { onRegenerateMessage: regenerate, turnOptions: fallback } = latest.current;
    void regenerate?.(assistantMessageId, fallback);
  }, []);

  /**
   * The welcome suggestions the empty chat offers — fetched once by the layout,
   * read from the same query here.
   */
  const { mutate: recordSuggestionUsage } = useRecordSuggestionUsage();

  const handleSubmit = async (dictated?: string) => {
    // Dictation submits the text it just transcribed rather than relying on the
    // draft state, which has not flushed yet in the tick it was set.
    //
    // Guarded on the TYPE, not just on presence: this is passed to event
    // handlers elsewhere in the tree, and a press event arriving here as
    // `dictated` is assignable at every step while being nothing like a string.
    const draft = typeof dictated === 'string' ? dictated : inputValue;
    const hasText = draft.trim().length > 0;
    if ((!hasText && attachments.length === 0) || isLoading || disabled) return;
    // An edit rewrites the question's words; an attachment alone does not
    // make a replacement for them.
    if (editing !== undefined && !hasText) return;
    // Signed-out: open the SDK sign-in dialog instead of firing a request that
    // would 401. The draft stays in the input for after sign-in.
    if (!isAuthenticated) {
      signIn().catch(() => {});
      return;
    }
    const content = draft;
    const pendingAttachments = attachments.length > 0 ? attachments : undefined;
    const options: SendOptions = turnOptions;

    // Clear optimistically. The send path restores text, attachments and the
    // turn's connector and skills to this draft if the request fails.
    clearDraft();

    if (editing !== undefined) {
      await edit.submit(content, options, pendingAttachments);
      return;
    }

    await onSubmit(content, pendingAttachments, options);
  };

  /**
   * A welcome suggestion, picked: sent through the same submit path as a typed
   * message. A template has blanks to fill, so it goes into the composer for
   * the person to finish instead of being sent with its placeholders.
   *
   * Stable, reading the newest `handleSubmit` through a ref: it is a prop of
   * the memoised thread.
   */
  const handleSubmitRef = useRef(handleSubmit);
  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  });
  const handlePickSuggestion = useCallback(
    (suggestion: Suggestion) => {
      recordSuggestionUsage(suggestion.suggestionId);
      if (suggestion.isTemplate) {
        setInputValue(suggestion.text);
        return;
      }
      void handleSubmitRef.current(suggestion.text);
    },
    [recordSuggestionUsage],
  );


  // The old composer's suggestions, over it: welcome first, then matches.
  const suggestions = useComposerSuggestions({
    draft: inputValue,
    enabled: isMainScreen && !disabled,
    onPick: handlePickSuggestion,
  });
  const { onKeyPress: onSuggestionKeyPress } = suggestions;
  const cancelEdit = edit.cancel;
  const handleComposerKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      // Escape leaves an edit, as its Cancel does: it is the top-most thing
      // open while the question is being rewritten.
      if (editing !== undefined && event.nativeEvent.key === 'Escape') {
        event.preventDefault();
        cancelEdit();
        return;
      }
      onSuggestionKeyPress(event);
    },
    [editing, cancelEdit, onSuggestionKeyPress],
  );

  if (intro) {
    return (
      <ChatWorkspace
        header={<AiChatMobileHeader title="Alia" />}
        background={intro.background}
      >
        {intro.content}
      </ChatWorkspace>
    );
  }

  return (
    <ChatWorkspace
      background={
        <AmbientField
          waveAmplitude={wave.waveAmplitude}
          agentState={wave.agentState}
          intensity={wave.intensity}
          isDarkMode={isDarkColorScheme}
          // The native stack keeps this screen mounted under whatever is
          // pushed over it; its field does not keep animating back there.
          paused={!onShow}
        />
      }
      project={projectName}
      title={conversationTitle || agentName || t('chat.newChat')}
      actions={headerActions}
      header={<AiChatMobileHeader title={conversationTitle || agentName || 'Alia'} />}
      composer={
        isVoiceActive && voice ? (
          <View style={{ paddingBottom: insets.bottom }}>
            <VoiceControls
              roomState={voice.roomState}
              agentState={voice.agentState}
              isMuted={voice.isMuted}
              onToggleMute={voice.toggleMute}
              onEnd={voice.deactivateVoice}
              primaryColor={colors.primary}
              labels={voiceControlLabels}
            />
          </View>
        ) : (
          // A fragment, as in the template: the footer's gap spaces the pill
          // and the status bar.
          <>
            <ComposerSuggestions
              completions={suggestions.completions}
              selected={suggestions.selected}
              onPick={handlePickSuggestion}
            />
            <Composer
              // A different account is a different composer: reads in flight
              // for the last one are aborted rather than landing here.
              key={composer.address.account ?? ''}
              onKeyPress={handleComposerKeyPress}
              inputRef={composerInputRef}
              value={inputValue}
              onValueChange={setInputValue}
              onSubmit={handleSubmit}
              busy={isLoading}
              disabled={disabled}
              onStop={onStop}
              disableKeyboardAvoidance
              {...composer.props}
              emptyAction={voiceAction}
              accessory={
                <ScrollToBottomButton
                  visible={!isAtBottom}
                  onPress={jumpToEnd}
                  accessibilityLabel={t('chat.bloom.scrollToLatest')}
                />
              }
              placeholder={
                disabled
                  ? t('usageLimit.inputDisabledPlaceholder')
                  : editing !== undefined
                    ? t('composer.editPlaceholder')
                    : t('composer.placeholder')
              }
              status={
                editing !== undefined ? (
                  // Where the chat's folder sits, while a question is being
                  // rewritten: what is happening, and the way out of it.
                  // Drawn as the status tab it replaces: the thread scrolls
                  // behind the composer, and a strip without the tab's surface
                  // printed its words over the transcript's.
                  <View
                    className="mx-7 h-[34px] flex-row items-center gap-2 rounded-t-2xl px-2 py-1"
                    style={{ backgroundColor: theme.colors.backgroundTertiary }}
                  >
                    <RiEditLine size="sm" />
                    <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>
                      {t('composer.editingMessage')}
                    </Text>
                    <Button variant="ghost" size="xs" onPress={edit.cancel}>
                      {t('composer.cancelEdit')}
                    </Button>
                  </View>
                ) : projectName ? (
                  <ComposerPanelStatusTab project={projectName} />
                ) : undefined
              }
            />
            {insets.bottom > 0 ? <KeyboardSafeAreaFloor inset={insets.bottom} /> : null}
          </>
        )
      }
    >
      <ChatInterface
        messages={messages}
        threadRef={threadRef}
        onScroll={onThreadScroll}
        // Only while there is something above to load: the thread anchors the
        // next growth after any `onStartReached`, and a request that can bring
        // nothing would leave that anchor armed for a streamed token.
        onLoadHistory={
          onLoadHistory === undefined || !hasMoreHistory ? undefined : handleLoadHistory
        }
        isLoading={isLoading}
        conversationLoading={conversationLoading}
        bottomPadding={0}
        voiceAgentState={voice?.agentState}
        historyMessages={historyMessages}
        isLoadingHistory={isLoadingHistory}
        activeConversationId={conversationId}
        focusCursor={focusCursor}
        agentActivity={agentActivity}
        agentSessionId={agentSessionId}
        onApprovePlan={onApprovePlan}
        onRejectPlan={onRejectPlan}
        suggestedNewConversation={suggestedNewConversation}
        onAcceptNewConversation={onAcceptNewConversation}
        onDismissNewConversation={onDismissNewConversation}
        failedTurn={failedTurn}
        onRetryTurn={onRetryTurn}
        onRegenerate={onRegenerateMessage === undefined ? undefined : handleRegenerate}
        onStartEdit={edit.start}
        callActive={isVoiceActive}
      />
    </ChatWorkspace>
  );
};

