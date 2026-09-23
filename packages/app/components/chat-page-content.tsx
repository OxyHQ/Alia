import { ChatInterface } from '@/components/chat-interface';
import { ChatWorkspace } from '@/components/chat/chat-workspace';
import type { WelcomeIntroSlots } from '@/components/welcome-intro';
import { Composer } from '@/components/chat/composer/composer';
import { useAliaComposer } from '@/components/chat/composer/use-alia-composer';
import type { Attachment } from '@/components/chat/composer/types';
import type { AgentActivityState } from '@/lib/hooks/use-agent-activity';
import type { FailedTurn, SendOptions } from '@/lib/hooks/use-streaming-chat';
import { useTranslation } from '@/lib/hooks/use-translation';
import type { useVoiceMode } from '@/lib/hooks/use-voice-mode';
import { useStore } from '@/lib/stores/global-store';
import { useProjectsStore } from '@/lib/stores/projects-store';
import type { ThreadMessage } from '@/lib/thread-history';
import { useColorScheme } from '@/lib/useColorScheme';
import type { Message } from '@/types/chat';
import { AmbientField } from '@/components/ambient-field';
import { useTTS } from '@/lib/hooks/use-tts';
import { VoiceControls, useAmbientWave } from '@alia.onl/sdk/voice';
import {
  AiChatMobileHeader,
  type AiChatThreadHandle,
} from '@oxy.so/bloom/ai-chat';
import { ComposerPanelStatusTab } from '@oxy.so/bloom/composer-panel';
import { useAuth } from '@oxy.so/services';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
 * became a list built in `components/chat/composer/add-menu.tsx`, and this
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
   * drawer keeps every visited chat mounted, so this is what decides which
   * instance a `composerDraft` belongs to.
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
  /** The model this chat sends with (a conversation remembers its own). */
  selectedModel?: string;
  onModelChange?: (model: string) => void;
  /**
   * The signed-out welcome, in place of the conversation: its field in the
   * container's background slot and its words in the content area, with no
   * composer until it is answered.
   */
  intro?: WelcomeIntroSlots;
}

export const ChatPageContent = ({
  messages,
  isLoading,
  onSubmit,
  onStop,
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
  intro,
}: ChatPageContentProps) => {
  const { isAuthenticated, signIn } = useAuth();
  const { t } = useTranslation();
  const isMainScreen = messages.length === 0;
  // The same composer every screen that asks Alia something uses.
  const composer = useAliaComposer({
    locked: isLoading || disabled,
    offerGhost: isMainScreen,
    selectedModel,
    onModelChange,
  });
  const { attachments, turnOptions, restoreTurn, clearTurn } = composer;

  const isVoiceActive = voice?.isVoiceActive ?? false;
  const [inputValue, setInputValue] = useState('');

  // Draft handed over by another route, or handed back by a send that failed.
  // `target` picks the one screen it belongs to and the seq marks it consumed,
  // so this needs no effect and no write back to the store.
  const composerDraft = useStore((state) => state.composerDraft);
  const composerDraftSeq = useStore((state) => state.composerDraftSeq);
  const [appliedDraftSeq, setAppliedDraftSeq] = useState(0);
  if (
    composerDraft &&
    composerDraftSeq !== appliedDraftSeq &&
    composerDraft.target === (conversationId ?? null)
  ) {
    setAppliedDraftSeq(composerDraftSeq);
    setInputValue(composerDraft.text);
    restoreTurn({
      mcpServerId: composerDraft.mcpServerId,
      skillNames: composerDraft.skillNames,
    });
  }

  const { colors, isDarkColorScheme } = useColorScheme();
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
  /**
   * The chat's folder, as the sidebar's tree files it: its project, or
   * "Recent". It is the breadcrumb's crumb and the composer's status tab.
   */
  const projects = useProjectsStore((state) => state.projects);
  const recentLabel = t('sidebar.recent');
  const projectName = conversationId
    ? (projects.find((p) => p.conversationIds.includes(conversationId))?.name ??
      recentLabel)
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

  useEffect(() => {
    useStore.getState().setGhostMode(false);
  }, []);

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
    // selected connector through composerDraft if the request fails.
    setInputValue('');
    useStore.getState().clearAttachments();

    const sent = await onSubmit(content, pendingAttachments, options);
    if (sent) clearTurn();
  };


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
        />
      }
      project={projectName}
      title={conversationTitle || agentName || t('chat.newChat')}
      header={<AiChatMobileHeader title={conversationTitle || agentName || 'Alia'} />}
      composer={
        isVoiceActive && voice ? (
          <View style={{ paddingBottom: insets.bottom }}>
            <VoiceControls
              roomState={voice.roomState}
              agentState={voice.agentState}
              isMuted={voice.isMuted}
              cohostActive={voice.cohostActive}
              currentSpeaker={voice.currentSpeaker}
              roundComplete={voice.roundComplete}
              onToggleMute={voice.toggleMute}
              onEnableCohost={voice.enableCohost}
              onDisableCohost={voice.disableCohost}
              onContinueCohost={voice.continueCohost}
              onEnd={voice.deactivateVoice}
              primaryColor={colors.primary}
            />
          </View>
        ) : (
          // A fragment, as in the template: the footer's gap spaces the pill
          // and the status bar.
          <>
            <Composer
              value={inputValue}
              onValueChange={setInputValue}
              onSubmit={handleSubmit}
              busy={isLoading}
              disabled={disabled}
              onStop={onStop}
              disableKeyboardAvoidance
              {...composer.props}
              placeholder={
                disabled ? t('usageLimit.inputDisabledPlaceholder') : t('composer.placeholder')
              }
              status={
                projectName ? (
                  <ComposerPanelStatusTab project={projectName} />
                ) : undefined
              }
            />
            {insets.bottom > 0 ? <View style={{ height: insets.bottom }} /> : null}
          </>
        )
      }
    >
      <ChatInterface
        messages={messages}
        threadRef={threadRef}
        onLoadHistory={
          onLoadHistory === undefined ? undefined : handleLoadHistory
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
      />
    </ChatWorkspace>
  );
};
