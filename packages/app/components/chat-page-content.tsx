import { ChatInterface } from '@/components/chat-interface';
import { ChatWorkspace } from '@/components/chat/chat-workspace';
import type { WelcomeIntroSlots } from '@/components/welcome-intro';
import { useComposerAddMenu } from '@/components/chat/composer/add-menu';
import { Composer } from '@/components/chat/composer/composer';
import { useComposerLineup } from '@/components/chat/composer/model-lineup';
import type { Attachment } from '@/components/chat/composer/types';
import {
  buildTurnSelection,
  toggleConnectorId,
  toggleSkillName,
} from '@/lib/chat/turn-selection';
import { useCapabilityModes } from '@/lib/chat/use-capability-modes';
import type { AgentActivityState } from '@/lib/hooks/use-agent-activity';
import { useMcpServers } from '@/lib/hooks/use-mcp-servers';
import { useInstalledSkills } from '@/lib/hooks/use-skills';
import type { FailedTurn, SendOptions } from '@/lib/hooks/use-streaming-chat';
import { useTranslation } from '@/lib/hooks/use-translation';
import type { useVoiceMode } from '@/lib/hooks/use-voice-mode';
import { useStore } from '@/lib/stores/global-store';
import { useModelStore } from '@/lib/stores/model-store';
import { useProjectsStore } from '@/lib/stores/projects-store';
import { useUIStore } from '@/lib/stores/ui-store';
import type { ThreadMessage } from '@/lib/thread-history';
import { useColorScheme } from '@/lib/useColorScheme';
import type { Message } from '@/types/chat';
import { VoiceControls } from '@alia.onl/sdk/voice';
import {
  AiChatMobileHeader,
  type AiChatThreadHandle,
} from '@oxy.so/bloom/ai-chat';
import { ComposerPanelStatusTab } from '@oxy.so/bloom/composer-panel';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { RiRobot2Line } from '@oxy.so/bloom/icons/RiRobot2Line';
import { RiSearchLine } from '@oxy.so/bloom/icons/RiSearchLine';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  selectedModel: string;
  onModelChange: (model: string) => void;
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
  selectedModel,
  onModelChange,
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
  intro,
}: ChatPageContentProps) => {
  const attachments = useStore((state) => state.attachments);
  const addAttachment = useStore((state) => state.addAttachment);
  const removeAttachment = useStore((state) => state.removeAttachment);
  const { isAuthenticated, signIn } = useAuth();
  const { t } = useTranslation();
  const { installed } = useMcpServers();
  const { active: modeActive, toggle: toggleMode } = useCapabilityModes();
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(
    null,
  );
  /**
   * Skills chosen for the NEXT message, by name.
   *
   * Per turn, like the connector beside it. Choosing none is the normal case:
   * Alia carries an index of the installed skills in its system prompt and can
   * load one on its own when a request matches. This is for saying "use this
   * one" out loud.
   */
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const { data: installedSkills = [] } = useInstalledSkills();
  /**
   * What this turn may be sent with, as two independent lists.
   *
   * Built by `lib/chat/turn-selection.ts` rather than derived in the menu's
   * markup, which is where the two lists used to be tangled: the skills block
   * was nested inside the connectors' `&&`, so an account with skills and no
   * running MCP server was shown none of them.
   */
  const turnSelection = useMemo(
    () =>
      buildTurnSelection({
        installedSkills,
        installedConnectors: installed,
        selectedSkillNames: selectedSkills,
        selectedConnectorId,
      }),
    [installedSkills, installed, selectedSkills, selectedConnectorId],
  );
  /**
   * Whether Alia may reach the open web on this turn.
   *
   * On the model store rather than in the global store beside the three, because it is one of the
   * composer's three persistent axes and the request reads it at send time —
   * see `lib/stores/model-store.ts`. The effort axis lives with the model rows
   * in the composer's combined picker, not in this capability menu.
   */
  const webSearch = useModelStore((s) => s.webSearch);
  const setWebSearch = useModelStore((s) => s.setWebSearch);

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
    setSelectedConnectorId(composerDraft.mcpServerId);
    setSelectedSkills(composerDraft.skillNames);
  }

  const { colors } = useColorScheme();
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

  const isMainScreen = messages.length === 0;

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
    const options: SendOptions = {
      mcpServerId: selectedConnectorId,
      skillNames: selectedSkills,
    };

    // Clear optimistically. The send path restores text, attachments and the
    // selected connector through composerDraft if the request fails.
    setInputValue('');
    useStore.getState().clearAttachments();

    const sent = await onSubmit(content, pendingAttachments, options);
    if (sent) {
      setSelectedConnectorId(null);
      setSelectedSkills([]);
    }
  };

  const handleWebSearch = () => {
    // Withholds three tools rather than rewording a prompt. The model decides
    // whether to call a tool, so "please do not search" in the system message
    // would be a switch the model may overrule; removing the tools is the only
    // implementation an off switch can honestly have.
    const next = !webSearch;
    setWebSearch(next);
    toast.info(next ? t('modes.searchOn') : t('modes.searchOff'));
  };

  /*
   * Pasting is no longer this file's business.
   *
   * There used to be a `handleImagePaste` here that did its own
   * `new FileReader()` with no progress, no cancel, and — the actual bug — no
   * `abort()` anywhere: removing a pasted image while it was still being read
   * left the read running to completion, holding the whole `File` and then
   * writing a data URL into an attachment that no longer existed. Paste and
   * drop now enter the composer's one intake queue, so the corner button that
   * stops a dropped file stops a pasted one too, and a failed read of either
   * can be tried again.
   */

  const handleCanvas = () => {
    useUIStore.getState().setRightPanel('canvas');
  };

  const handleToggleSkill = useCallback(
    (name: string) =>
      setSelectedSkills((current) => toggleSkillName(current, name)),
    [],
  );
  const handleToggleConnector = useCallback(
    (id: string) =>
      setSelectedConnectorId((current) => toggleConnectorId(current, id)),
    [],
  );

  /**
   * The panel's mode selector: how Alia works on this turn. The three are
   * the capability flags that already existed (agent, deep research), made
   * exclusive here because a turn is one or the other; the plan gate and the
   * toasts stay in `toggleMode`.
   */
  const chatModes = useMemo(
    () => [
      { id: 'chat', label: t('composer.modeChat'), description: t('composer.modeChatDescription'), icon: RiChat3Line },
      { id: 'agent', label: t('modes.agentLabel'), description: t('composer.agentDescription'), icon: RiRobot2Line },
      { id: 'research', label: t('modes.deepResearchLabel'), description: t('composer.deepResearchDescription'), icon: RiSearchLine },
    ],
    [t],
  );
  const chatMode = modeActive.agent ? 'agent' : modeActive.deepResearch ? 'research' : 'chat';
  const handleModeChange = useCallback(
    (next: string) => {
      if (next === chatMode) return;
      if (modeActive.agent) toggleMode('agent');
      if (modeActive.deepResearch) toggleMode('deepResearch');
      if (next === 'agent') toggleMode('agent');
      if (next === 'research') toggleMode('deepResearch');
    },
    [chatMode, modeActive, toggleMode],
  );

  const addMenu = useComposerAddMenu({
    addAttachment,
    // Nothing may be attached to a turn already streaming, or to a composer
    // the usage limit has closed — the same lock the old plus button wore,
    // now aimed at the three rows that need it rather than at the whole menu.
    canAttach: !isLoading && !disabled,
    modes: modeActive,
    toggleMode,
    webSearch,
    onToggleWebSearch: handleWebSearch,
    onOpenCanvas: handleCanvas,
    // Ghost decides whether what you are about to start gets saved, and a
    // stretch already on screen has been saved — so it is offered on an empty
    // conversation and nowhere else, exactly as it was.
    offerGhost: isMainScreen,
    turnSelection,
    onToggleSkill: handleToggleSkill,
    onToggleConnector: handleToggleConnector,
  });

  // The catalogue, in the shape Bloom's model menu takes — including the
  // entitlement gate, which survives as an intercepted change rather than a
  // row that refuses itself. See `model-lineup.ts`.
  const lineup = useComposerLineup(selectedModel, onModelChange);

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
      working={isLoading}
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
              attachments={attachments}
              onAddAttachment={addAttachment}
              onRemoveAttachment={removeAttachment}
              placeholder={
                disabled ? t('usageLimit.inputDisabledPlaceholder') : t('composer.placeholder')
              }
              providers={lineup.providers}
              model={lineup.model}
              onModelChange={lineup.onModelChange}
              effortLevels={lineup.effortLevels}
              effort={lineup.effort}
              onEffortChange={lineup.onEffortChange}
              modes={chatModes}
              mode={chatMode}
              onModeChange={handleModeChange}
              addMenu={addMenu.groups}
              onAddMenuSelect={addMenu.onSelect}
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
