import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { View, Pressable } from "react-native";
import Entypo from "@expo/vector-icons/Entypo";
import { useColorScheme } from "@/lib/useColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardStickyView } from "@/lib/keyboard";
import { LinearGradient } from "expo-linear-gradient";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { useStore } from "@/lib/stores/global-store";
import { useUIStore } from "@/lib/stores/ui-store";
import { X } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Composer } from "@/components/chat/composer/composer";
import { useComposerAddMenu } from "@/components/chat/composer/add-menu";
import { useComposerLineup } from "@/components/chat/composer/model-lineup";
import { LocalModelsInvite } from "@/components/local-models-invite";
import type { Attachment } from "@/components/chat/composer/types";
import { ScrollButton } from "@/components/ui/scroll-button";
import { ChatInterface } from "@/components/chat-interface";
import { useAtBottom } from "@/lib/hooks/use-at-bottom";
import type { AiChatThreadHandle } from "@oxy.so/bloom/ai-chat";
import { THREAD_COLUMN } from "@/lib/chat-layout";
import { ChatHeader } from "@/components/chat-header";
import { useAuth } from "@oxy.so/services";
import type { Message } from "@/types/chat";
import type { ThreadMessage } from "@/lib/thread-history";
import { toast } from "@oxy.so/bloom/toast";
import { VoiceControls, useAmbientWave } from "@alia.onl/sdk/voice";
import { AlertTriangle, Pencil } from "lucide-react-native";
import { AmbientField } from "@/components/ambient-field";
import { CreditWarningBanner } from "@/components/credit-warning-banner";
import { useModelStore } from "@/lib/stores/model-store";
import { useEntitlements } from "@/lib/hooks/use-billing";
import { useCredits } from "@/lib/hooks/use-credits";
import { useRouter } from "expo-router";
import { useTranslation } from "@/lib/hooks/use-translation";
import type { useVoiceMode } from "@/lib/hooks/use-voice-mode";
import { useTTS } from "@/lib/hooks/use-tts";
import type { AgentActivityState } from "@/lib/hooks/use-agent-activity";
import { AgentTerminal } from "@/components/agent-terminal";
import { Terminal as TerminalIcon, ChevronDown, ChevronUp } from "lucide-react-native";
import { useMcpServers } from "@/lib/hooks/use-mcp-servers";
import { useInstalledSkills } from "@/lib/hooks/use-skills";
import {
  buildTurnSelection,
  toggleConnectorId,
  toggleSkillName,
} from "@/lib/chat/turn-selection";
import { useCapabilityModes } from "@/lib/chat/use-capability-modes";
import type { SendOptions, FailedTurn } from "@/lib/hooks/use-streaming-chat";

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
  scrollViewRef: React.RefObject<GHScrollView | null>;
  isLoading: boolean;
  onSubmit: (value: string, attachments?: Attachment[], options?: SendOptions) => Promise<boolean>;
  onEditMessage: (messageId: string, newContent: string, options?: SendOptions) => Promise<boolean>;
  onRegenerateMessage: (assistantMessageId: string, options?: SendOptions) => Promise<boolean>;
  onStop?: () => void;
  onClear?: () => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  disabled?: boolean;
  conversationLoading?: boolean;
  voice?: VoiceState;
  onVoiceStart?: () => void;
  agentActivity?: AgentActivityState | null;
  agentId?: string | null;
  /**
   * The agent this thread belongs to, for the header.
   *
   * Two primitives rather than an identity object, because `ChatHeader` is
   * memoized against a screen that re-renders ~20×/s while streaming — see the
   * note on its props. They are passed straight through, never repackaged.
   */
  agentName?: string;
  agentColor?: string | null;
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
  /**
   * The thread's history and how to ask for more of it.
   *
   * All four are absent on `/c/:id`: a chat in the sidebar is one conversation
   * with nothing behind it, so there is no older stretch to page into and no
   * seam to draw.
   */
  historyMessages?: ThreadMessage[];
  hasMoreHistory?: boolean;
  isLoadingHistory?: boolean;
  onLoadHistory?: () => void;
  /**
   * Search THIS thread, when there is a thread to search.
   *
   * Absent on `/c/:id`, where the header's magnifier keeps opening the app-wide
   * palette — a different question: that one finds a chat, this one finds a
   * sentence, and only a thread has stretches behind it to look through.
   */
  onSearchPress?: () => void;
  /** The message a jump was aimed at, by cursor, or `null` at the present. */
  focusCursor?: string | null;
  /**
   * Export this conversation as Markdown, for the header's menu. A stable
   * callback built by the screen that owns the messages — see `ChatHeader`'s
   * note on why it is not the messages themselves.
   */
  onExport?: () => void;
  /**
   * The turn that got no answer, drawn in the thread with an error and a
   * retry, or `null`. Both are passed straight through to the list.
   */
  failedTurn?: FailedTurn | null;
  onRetryTurn?: () => void;
}


export const ChatPageContent = ({
  messages,
  scrollViewRef,
  isLoading,
  onSubmit,
  onEditMessage,
  onRegenerateMessage,
  onStop,
  onClear,
  selectedModel,
  onModelChange,
  disabled = false,
  conversationLoading,
  voice,
  onVoiceStart,
  agentActivity,
  agentId,
  agentName,
  agentColor,
  agentSessionId,
  onApprovePlan,
  onRejectPlan,
  suggestedNewConversation,
  onAcceptNewConversation,
  onDismissNewConversation,
  conversationId,
  historyMessages,
  hasMoreHistory = false,
  isLoadingHistory = false,
  onLoadHistory,
  onSearchPress,
  focusCursor,
  onExport,
  failedTurn,
  onRetryTurn,
}: ChatPageContentProps) => {
  const attachments = useStore((state) => state.attachments);
  const addAttachment = useStore((state) => state.addAttachment);
  const removeAttachment = useStore((state) => state.removeAttachment);
  const { isAuthenticated, signIn } = useAuth();
  const { data: entitlements } = useEntitlements();
  const { data: creditsInfo } = useCredits();
  const router = useRouter();
  const { t } = useTranslation();
  const { installed } = useMcpServers();
  const { active: modeActive, toggle: toggleMode } = useCapabilityModes();
  const [selectedConnectorId, setSelectedConnectorId] = useState<string | null>(null);
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
    () => buildTurnSelection({
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
  const { ttsWaveAmplitude, playbackState: ttsPlaybackState } = useTTS();

  // Ambient wave — one persistent overlay across idle / voice / TTS / STT.
  // (STT is read inside useAmbientWave from the SDK store — the live one.)
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

  const [inputValue, setInputValue] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);

  // Draft handed over by another route, or handed back by a send that failed.
  // `target` picks the one screen it belongs to and the seq marks it consumed,
  // so this needs no effect and no write back to the store.
  const composerDraft = useStore((state) => state.composerDraft);
  const composerDraftSeq = useStore((state) => state.composerDraftSeq);
  const [appliedDraftSeq, setAppliedDraftSeq] = useState(0);
  if (composerDraft && composerDraftSeq !== appliedDraftSeq && composerDraft.target === (conversationId ?? null)) {
    setAppliedDraftSeq(composerDraftSeq);
    setInputValue(composerDraft.text);
    setSelectedConnectorId(composerDraft.mcpServerId);
    setSelectedSkills(composerDraft.skillNames);
  }

  const [showTerminal, setShowTerminal] = useState(false);
  const { colors, isDarkColorScheme: isDarkMode } = useColorScheme();
  const insets = useSafeAreaInsets();

  const [bottomBarHeight, setBottomBarHeight] = useState(160);
  const isMainScreen = messages.length === 0;

  /**
   * Reading upwards asks for the page above, and holds the reader in place
   * while it lands — both inside the scroll hook, because they are one act: a
   * page that arrives without the position being restored leaves the reader at
   * the top again, asking for the next one.
   */
  const { isAtBottom, onScroll } = useAtBottom();

  /**
   * Ask for the page above, unless there is nothing above or one is already
   * coming.
   *
   * Bloom fires `onStartReached` once per approach and re-arms when the reader
   * leaves the zone, so the only guards left here are about the DATA: a thread
   * with no older stretch, and a request already in flight.
   */
  const handleLoadHistory = useCallback(() => {
    if (onLoadHistory === undefined || !hasMoreHistory || isLoadingHistory) return;
    onLoadHistory();
  }, [onLoadHistory, hasMoreHistory, isLoadingHistory]);

  const threadRef = useRef<AiChatThreadHandle | null>(null);
  const scrollToBottom = useCallback(() => {
    threadRef.current?.scrollToEnd({ animated: true });
  }, []);

  useEffect(() => {
    useStore.getState().setGhostMode(false);
  }, []);

  // Stable identity so the memoized ChatHeader isn't re-rendered per
  // streaming flush by a fresh inline closure.
  const handleGhostModeToggle = useCallback(() => toggleMode('ghost'), [toggleMode]);

  const handleStartEdit = useCallback((messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setInputValue(content);
  }, []);

  const handleRegenerate = useCallback((assistantMessageId: string) => {
    // Replay the prompt with whatever the composer is set to NOW — regenerating
    // after switching connector or skills should honour the new selection.
    void onRegenerateMessage(assistantMessageId, {
      mcpServerId: selectedConnectorId,
      skillNames: selectedSkills,
    });
  }, [onRegenerateMessage, selectedConnectorId, selectedSkills]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setInputValue("");
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
    // Editing changes the existing text message; attachments belong to new
    // turns and must not make an empty edit look submittable.
    if (editingMessageId && !hasText) return;
    // Signed-out: open the SDK sign-in dialog instead of firing a request that
    // would 401. The draft stays in the input for after sign-in.
    if (!isAuthenticated) {
      signIn().catch(() => {});
      return;
    }
    const content = draft;
    const pendingAttachments = attachments.length > 0 ? attachments : undefined;
    const options: SendOptions = { mcpServerId: selectedConnectorId, skillNames: selectedSkills };

    // Clear optimistically. Both send paths restore text, attachments and the
    // selected connector through composerDraft if the request fails.
    setInputValue("");
    useStore.getState().clearAttachments();

    if (editingMessageId) {
      const sent = await onEditMessage(editingMessageId, content, options);
      if (sent) {
        setEditingMessageId(null);
        setSelectedConnectorId(null);
        setSelectedSkills([]);
      }
      return;
    }
    const sent = await onSubmit(content, pendingAttachments, options);
    if (sent) {
      setSelectedConnectorId(null);
      setSelectedSkills([]);
    }
  };

  // Send a suggestion's text directly (non-template selections) via the same send path.
  const handleSuggestionSend = useCallback(async (text: string) => {
    if (isLoading || disabled) return;
    if (!isAuthenticated) {
      signIn().catch(() => {});
      return;
    }
    setInputValue("");
    const sent = await onSubmit(text, undefined, { mcpServerId: selectedConnectorId, skillNames: selectedSkills });
    if (sent) {
      setSelectedConnectorId(null);
      setSelectedSkills([]);
    }
  }, [isLoading, disabled, isAuthenticated, signIn, onSubmit, selectedConnectorId, selectedSkills]);

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

  const handleVoiceActivate = useCallback(() => {
    if (!isAuthenticated) {
      toast.error(t('subscribe.signInRequired'));
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
    if (voice) {
      voice.activateVoice();
    } else if (onVoiceStart) {
      onVoiceStart();
    }
  }, [voice, onVoiceStart, isAuthenticated, entitlements, creditsInfo, t, router]);

  const handleToggleSkill = useCallback(
    (name: string) => setSelectedSkills((current) => toggleSkillName(current, name)),
    [],
  );
  const handleToggleConnector = useCallback(
    (id: string) => setSelectedConnectorId((current) => toggleConnectorId(current, id)),
    [],
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

  return (
    <View className="flex-1 bg-background">
      <View className="flex-1 relative">
        {/* Ambient field — subtle at idle, swelling with speech. Rendered before
            the message list so it genuinely sits behind it: it now covers the
            whole panel rather than a band at the bottom. */}
        <AmbientField
          waveAmplitude={wave.waveAmplitude}
          agentState={wave.agentState}
          intensity={wave.intensity}
          isDarkMode={isDarkMode}
        />

        <ChatInterface
          messages={messages}
          threadRef={threadRef}
          onLoadHistory={onLoadHistory === undefined ? undefined : handleLoadHistory}
          isLoading={isLoading}
          conversationLoading={conversationLoading}
          onStartEdit={handleStartEdit}
          onRegenerate={handleRegenerate}
          bottomPadding={bottomBarHeight}
          isVoiceActive={isVoiceActive}
          voiceAgentState={voice?.agentState}
          onScroll={onScroll}
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

        <LinearGradient
          colors={[colors.background, "transparent"]}
          locations={[0.1, 1]}
          style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 10, paddingBottom: 32, pointerEvents: "box-none" }}
        >
          <ChatHeader
            onGhostModePress={handleGhostModeToggle}
            ghostModeActive={modeActive.ghost}
            onClear={onClear}
            isConversation={messages.length > 0}
            agentName={agentName}
            agentColor={agentColor}
            onSearchPress={onSearchPress}
            onExport={onExport}
          />
        </LinearGradient>

        {/* Bottom area: voice controls OR text input */}
        {isVoiceActive && voice ? (
          <View
            style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10, paddingBottom: insets.bottom }}
            onLayout={(e) => setBottomBarHeight(e.nativeEvent.layout.height)}
          >
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
          <KeyboardStickyView
            offset={{ closed: 0, opened: 0 }}
            style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10 }}
            onLayout={(e) => setBottomBarHeight(e.nativeEvent.layout.height)}
          >
          <LinearGradient
            colors={["transparent", colors.background]}
            locations={[0, 0.9]}
            style={{ paddingTop: 24, paddingBottom: insets.bottom }}
          >
            <CreditWarningBanner selectedModel={selectedModel} onSwitchModel={onModelChange} />

            {disabled && (
              <View className={`${THREAD_COLUMN} px-4 pb-1`}>
                <View className="flex-row items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2">
                  <AlertTriangle size={14} className="text-destructive" />
                  <Text className="text-xs text-destructive flex-1">
                    {t('usageLimit.limitReachedBanner')}
                  </Text>
                </View>
              </View>
            )}

            <View className="px-4 py-3">
              <View className={`${THREAD_COLUMN} relative`}>
                  {messages.length > 0 && (
                    <View style={{ position: "absolute", top: -48, right: 0, zIndex: -1 }}>
                      <ScrollButton
                        isAtBottom={isAtBottom}
                        onScrollToBottom={scrollToBottom}
                      />
                    </View>
                  )}
                  {editingMessageId && (
                    <View className="flex-row items-center gap-2 mb-2 px-1">
                      <Pencil size={14} className="text-primary" />
                      <Text className="text-xs text-muted-foreground flex-1">Editing message</Text>
                      <Pressable onPress={handleCancelEdit} className="active:opacity-70">
                        <X size={14} className="text-muted-foreground" />
                      </Pressable>
                    </View>
                  )}
                  {/*
                    The one time Alia asks whether it may look for a model on
                    this machine.

                    It used to hang off the model selector, because that is
                    where the answer is relevant — and the selector is Bloom's
                    now, with no slot to hang anything from. So it anchors to
                    the composer instead, which is the next box out and the one
                    the model chip lives in. The card itself decides whether it
                    appears at all (signed in, unasked, large screen, once);
                    all this position changes is what it points at.
                  */}
                  <LocalModelsInvite>
                  <Composer
                    value={inputValue}
                    onValueChange={setInputValue}
                    onSubmit={handleSubmit}
                    // The two locks, kept apart. `busy` is the stream: send
                    // becomes stop, and Bloom keeps stop outside `disabled`'s
                    // reach by contract — which is the property the old
                    // composer had to fight its own DOM to hold on to.
                    // `disabled` is the usage limit and nothing else.
                    busy={isLoading}
                    disabled={disabled}
                    onStop={onStop}
                    disableKeyboardAvoidance
                    attachments={attachments}
                    onAddAttachment={addAttachment}
                    onRemoveAttachment={removeAttachment}
                    autocomplete
                    showDefaultSuggestions={isMainScreen && !conversationLoading}
                    onSuggestionSend={handleSuggestionSend}
                    floatingAutocomplete
                    placeholder={disabled ? t('usageLimit.inputDisabledPlaceholder') : "Message Alia..."}
                    models={lineup.models}
                    model={lineup.model}
                    onModelChange={lineup.onModelChange}
                    effortLevels={lineup.effortLevels}
                    effort={lineup.effort}
                    onEffortChange={lineup.onEffortChange}
                    addMenu={addMenu.groups}
                    onAddMenuSelect={addMenu.onSelect}
                    emptyAction={
                      <Button
                        size="icon"
                        className="h-9 w-9 rounded-full items-center justify-center"
                        onPress={handleVoiceActivate}
                        accessibilityLabel={t('modes.voiceMode')}
                      >
                        <Entypo name="sound" size={18} color={colors.primaryForeground} />
                      </Button>
                    }
                  />
                  </LocalModelsInvite>
              </View>
            </View>
          </LinearGradient>
          </KeyboardStickyView>
        )}
      </View>

      {/* Agent Terminal Panel — collapsible at the bottom */}
      {agentId && showTerminal && (
        <View className="border-t border-border" style={{ height: 280 }}>
          <View className="flex-row items-center justify-between px-3 py-1.5 bg-card">
            <View className="flex-row items-center gap-2">
              <TerminalIcon size={12} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground">Agent Terminal</Text>
            </View>
            <Pressable onPress={() => setShowTerminal(false)} className="p-1">
              <ChevronDown size={14} className="text-muted-foreground" />
            </Pressable>
          </View>
          <AgentTerminal agentId={agentId} />
        </View>
      )}

      {/* Terminal toggle button — shows when agent mode is active */}
      {agentId && !showTerminal && modeActive.agent && (
        <Pressable
          onPress={() => setShowTerminal(true)}
          className="absolute bottom-32 right-4 z-20 bg-card rounded-lg px-3 py-2 flex-row items-center gap-2 border border-border shadow-lg"
        >
          <TerminalIcon size={14} className="text-muted-foreground" />
          <Text className="text-xs text-muted-foreground">Terminal</Text>
          <ChevronUp size={12} className="text-muted-foreground" />
        </Pressable>
      )}

    </View>
  );
};
