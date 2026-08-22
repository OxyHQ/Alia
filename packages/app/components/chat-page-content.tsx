import { useState, useCallback, useEffect, useMemo } from "react";
import { View, Pressable, useWindowDimensions } from "react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardStickyView } from "@/lib/keyboard";
import { LinearGradient } from "expo-linear-gradient";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { useStore } from "@/lib/stores/global-store";
import { useUIStore } from "@/lib/stores/ui-store";
import { Globe, MoreHorizontal, X, Ghost, Sparkles, Bot, Search } from "lucide-react-native";
import Entypo from "@expo/vector-icons/Entypo";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PromptInput } from "@/components/ui/prompt-input/prompt-input";
import type { Attachment } from "@/components/ui/prompt-input/context";
import { ScrollButton } from "@/components/ui/scroll-button";
import { ChatInterface } from "@/components/chat-interface";
import { ChatHeader } from "@/components/chat-header";
import { useAuth } from "@oxyhq/services";
import type { Message } from "@/types/chat";
import { toast } from "@oxyhq/bloom/toast";
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

/**
 * The capabilities a person can switch on, and every one of them reaches the
 * request.
 *
 * ## Three were removed because they reached nothing
 *
 * `toggleMode` writes to a local `Set` and, for three of the six, to a store the
 * request body reads. The other three wrote to the `Set` and stopped there:
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
 * What is left is the three that were already wired: ghost (client-side, it
 * stops the turn creating a conversation), agent (`agentMode`, which adds the
 * delegation tools) and deep research (`deepResearch`, which diverts the turn
 * into the real multi-step research engine).
 */
type Mode = 'agent' | 'ghost' | 'deepResearch';

const MODE_CONFIG: Record<Mode, {
  label: string;
  icon: React.ComponentType<{ size: number; color: string }>;
  color: string;
  onToast: string;
  offToast: string;
  featureId?: string;
}> = {
  ghost:            { label: 'modes.ghostLabel',        icon: Ghost,       color: '#00b2ff', onToast: 'modes.ghostOn',            offToast: 'modes.ghostOff' },
  agent:            { label: 'modes.agentLabel',        icon: Bot,         color: '#f97316', onToast: 'modes.agentOn',            offToast: 'modes.agentOff', featureId: 'agent-mode' },
  deepResearch:     { label: 'modes.deepResearchLabel', icon: Search,      color: '#10b981', onToast: 'modes.deepResearchOn',     offToast: 'modes.deepResearchOff', featureId: 'deep-research' },
};

const MODE_ORDER: Mode[] = ['ghost', 'agent', 'deepResearch'];

type VoiceState = ReturnType<typeof useVoiceMode>;

interface ChatPageContentProps {
  messages: Message[];
  scrollViewRef: React.RefObject<GHScrollView | null>;
  isLoading: boolean;
  onSubmit: (value: string, attachments?: Attachment[]) => void;
  onEditMessage: (messageId: string, newContent: string) => void;
  onStop?: () => void;
  onClear?: () => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  activeRole?: { id: string; name: string };
  onRemoveRole?: () => void;
  disabled?: boolean;
  conversationLoading?: boolean;
  voice?: VoiceState;
  onVoiceStart?: () => void;
  agentActivity?: AgentActivityState | null;
  agentId?: string | null;
  agentSessionId?: string | null;
  onApprovePlan?: (planId: string) => void;
  onRejectPlan?: (planId: string) => void;
  /**
   * The chat this screen is showing, or omitted for the new-chat screen. The
   * drawer keeps every visited chat mounted, so this is what decides which
   * instance a `composerDraft` belongs to.
   */
  conversationId?: string;
}


const ModeChip = ({ icon: Icon, label, color, onDismiss }: {
  icon: React.ComponentType<{ size: number; color: string }>;
  label: string;
  color: string;
  onDismiss: () => void;
}) => (
  <View className="h-10 rounded-full px-3 flex-row items-center gap-1.5" style={{ backgroundColor: `${color}20` }}>
    <Icon size={14} color={color} />
    <Text className="text-xs font-medium" style={{ color }}>{label}</Text>
    <Pressable onPress={onDismiss} className="active:opacity-70">
      <X size={12} color={color} />
    </Pressable>
  </View>
);

export const ChatPageContent = ({
  messages,
  scrollViewRef,
  isLoading,
  onSubmit,
  onEditMessage,
  onStop,
  onClear,
  selectedModel,
  onModelChange,
  activeRole,
  onRemoveRole,
  disabled = false,
  conversationLoading,
  voice,
  onVoiceStart,
  agentActivity,
  agentId,
  agentSessionId,
  onApprovePlan,
  onRejectPlan,
  conversationId,
}: ChatPageContentProps) => {
  const attachments = useStore((state) => state.attachments);
  const addAttachment = useStore((state) => state.addAttachment);
  const removeAttachment = useStore((state) => state.removeAttachment);
  const { isAuthenticated, signIn } = useAuth();
  const { data: entitlements } = useEntitlements();
  const { data: creditsInfo } = useCredits();
  const router = useRouter();
  const { t } = useTranslation();
  const { width: screenWidth } = useWindowDimensions();
  const isNarrowScreen = screenWidth < 640;
  const [activeModes, setActiveModes] = useState<Set<Mode>>(new Set());
  /**
   * Whether Alia may reach the open web on this turn.
   *
   * On the model store rather than in `activeModes`, because it is one of the
   * composer's three persistent axes and the request reads it at send time —
   * see `lib/stores/model-store.ts`. The effort axis lives beside the model
   * picker in the header, not here.
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
  }

  const [showTerminal, setShowTerminal] = useState(false);
  const { colors, isDarkColorScheme: isDarkMode } = useColorScheme();
  const insets = useSafeAreaInsets();

  const [bottomBarHeight, setBottomBarHeight] = useState(160);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isMainScreen = messages.length === 0;

  const handleScrollToBottom = useCallback(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [scrollViewRef]);

  useEffect(() => {
    useStore.getState().setGhostMode(false);
  }, []);

  const toggleMode = useCallback((mode: Mode) => {
    const config = MODE_CONFIG[mode];
    if (config.featureId && !entitlements?.features[config.featureId]) {
      toast.info(t('subscribe.featureRequiresPlan', { feature: t(config.label) }));
      router.push('/(biglayout)/subscribe');
      return;
    }
    setActiveModes(prev => {
      const next = new Set(prev);
      if (next.has(mode)) {
        next.delete(mode);
        toast.info(t(config.offToast));
      } else {
        next.add(mode);
        toast.info(t(config.onToast));
      }
      if (mode === 'ghost') {
        useStore.getState().setGhostMode(next.has('ghost'));
      }
      if (mode === 'agent') {
        useStore.getState().setAgentMode(next.has('agent'));
      }
      if (mode === 'deepResearch') {
        useStore.getState().setDeepResearchMode(next.has('deepResearch'));
      }
      return next;
    });
  }, [entitlements, t, router]);

  // Stable identity so the memoized ChatHeader isn't re-rendered per
  // streaming flush by a fresh inline closure.
  const handleGhostModeToggle = useCallback(() => toggleMode('ghost'), [toggleMode]);

  const handleStartEdit = useCallback((messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setInputValue(content);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setInputValue("");
  }, []);

  const handleSubmit = () => {
    if (!inputValue.trim() || isLoading || disabled) return;
    // Signed-out: open the SDK sign-in dialog instead of firing a request that
    // would 401. The draft stays in the input for after sign-in.
    if (!isAuthenticated) {
      signIn().catch(() => {});
      return;
    }
    if (editingMessageId) {
      onEditMessage(editingMessageId, inputValue);
      setEditingMessageId(null);
      setInputValue("");
      return;
    }
    onSubmit(inputValue, attachments.length > 0 ? attachments : undefined);
    setInputValue("");
    useStore.getState().clearAttachments();
  };

  // Send a suggestion's text directly (non-template selections) via the same send path.
  const handleSuggestionSend = useCallback((text: string) => {
    if (isLoading || disabled) return;
    if (!isAuthenticated) {
      signIn().catch(() => {});
      return;
    }
    onSubmit(text);
    setInputValue("");
  }, [isLoading, disabled, isAuthenticated, signIn, onSubmit]);

  const handleWebSearch = () => {
    // Withholds three tools rather than rewording a prompt. The model decides
    // whether to call a tool, so "please do not search" in the system message
    // would be a switch the model may overrule; removing the tools is the only
    // implementation an off switch can honestly have.
    const next = !webSearch;
    setWebSearch(next);
    toast.info(next ? t('modes.searchOn') : t('modes.searchOff'));
  };

  const handleAddSources = () => {
    toast.info(t('chat.addSourcesHint'));
  };

  const handleImagePaste = useCallback((files: File[]) => {
    files.forEach((file) => {
      const id = `paste-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      addAttachment({
        id,
        uri: "",
        type: "image",
        name: file.name || "Pasted image",
        size: file.size || 0,
        mimeType: file.type || "image/png",
        isLoading: true,
      });
      const reader = new FileReader();
      reader.onload = () => {
        useStore.getState().updateAttachment(id, {
          uri: reader.result as string,
          isLoading: false,
        });
      };
      reader.readAsDataURL(file);
    });
  }, [addAttachment]);

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

  const extraMenuItems = (
    <>
      <DropdownMenu.Item key="sources" onSelect={handleAddSources}>
        <DropdownMenu.ItemIcon ios={{ name: "link" }} />
        <DropdownMenu.ItemTitle>Add sources</DropdownMenu.ItemTitle>
      </DropdownMenu.Item>
      <DropdownMenu.Item key="canvas" onSelect={handleCanvas}>
        <DropdownMenu.ItemIcon ios={{ name: "pencil.tip" }} />
        <DropdownMenu.ItemTitle>Canvas</DropdownMenu.ItemTitle>
      </DropdownMenu.Item>
    </>
  );

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
          scrollViewRef={scrollViewRef}
          isLoading={isLoading}
          conversationLoading={conversationLoading}
          onStartEdit={handleStartEdit}
          bottomPadding={bottomBarHeight}
          isVoiceActive={isVoiceActive}
          voiceAgentState={voice?.agentState}
          onAtBottomChange={setIsAtBottom}
          agentActivity={agentActivity}
          agentSessionId={agentSessionId}
          onApprovePlan={onApprovePlan}
          onRejectPlan={onRejectPlan}
        />

        <LinearGradient
          colors={[colors.background, "transparent"]}
          locations={[0.1, 1]}
          style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 10, paddingBottom: 32, pointerEvents: "box-none" }}
        >
          <ChatHeader
            title="Alia"
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            onGhostModePress={handleGhostModeToggle}
            ghostModeActive={activeModes.has('ghost')}
            onClear={onClear}
            isConversation={messages.length > 0}
            isVoiceActive={isVoiceActive}
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
              <View className="mx-auto w-full max-w-3xl px-4 pb-1">
                <View className="flex-row items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2">
                  <AlertTriangle size={14} className="text-destructive" />
                  <Text className="text-xs text-destructive flex-1">
                    {t('usageLimit.limitReachedBanner')}
                  </Text>
                </View>
              </View>
            )}

            <View className="px-4 py-3">
              <View className="mx-auto w-full max-w-3xl relative">
                  {messages.length > 0 && (
                    <View style={{ position: "absolute", top: -48, right: 0, zIndex: -1 }}>
                      <ScrollButton
                        isAtBottom={isAtBottom}
                        onScrollToBottom={handleScrollToBottom}
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
                  <PromptInput
                    value={inputValue}
                    onValueChange={setInputValue}
                    onSubmit={handleSubmit}
                    isLoading={isLoading}
                    disabled={isLoading || disabled}
                    disableKeyboardAvoidance
                    attachments={attachments}
                    onAddAttachment={addAttachment}
                    onRemoveAttachment={removeAttachment}
                    onImagePaste={handleImagePaste}
                    autocomplete
                    showDefaultSuggestions={isMainScreen && !conversationLoading}
                    onSuggestionSend={handleSuggestionSend}
                    floatingAutocomplete
                    placeholder={disabled ? t('usageLimit.inputDisabledPlaceholder') : "Message Alia..."}
                    onStop={onStop}
                    emptyAction={
                      <Button
                        size="icon"
                        className="h-10 w-10 rounded-full items-center justify-center"
                        onPress={handleVoiceActivate}
                      >
                        <Entypo name="sound" size={18} color="white" />
                      </Button>
                    }
                    actionsRight={
                      <>
                        {/* Filled when the web is reachable, which is the
                            default — this button says what the request will do,
                            and the request has always been able to search. */}
                        <Button
                          variant={webSearch ? "default" : "ghost"}
                          size="icon"
                          className={cn(
                            "h-10 w-10 rounded-full items-center justify-center",
                            !webSearch && "web:hover:bg-muted active:bg-muted"
                          )}
                          onPress={handleWebSearch}
                          accessibilityLabel={t('modes.searchLabel')}
                        >
                          <Globe size={18} className={webSearch ? "text-primary-foreground" : "text-muted-foreground"} />
                        </Button>

                        {/* Ghost is surfaced by the header's ghost toggle, so it
                            gets no chip here — but stays in MODE_ORDER for the menu. */}
                        {MODE_ORDER.filter(mode => mode !== 'ghost').map(mode =>
                          activeModes.has(mode) && (
                            <ModeChip
                              key={mode}
                              icon={MODE_CONFIG[mode].icon}
                              label={t(MODE_CONFIG[mode].label)}
                              color={MODE_CONFIG[mode].color}
                              onDismiss={() => toggleMode(mode)}
                            />
                          )
                        )}

                        {activeRole && (
                          <View className="h-10 rounded-full px-3 bg-primary/10 flex-row items-center gap-1.5">
                            <Sparkles size={12} className="text-primary" />
                            <Text className="text-xs font-medium text-primary" numberOfLines={1}>
                              {activeRole.name}
                            </Text>
                            <Pressable onPress={onRemoveRole} className="active:opacity-70">
                              <X size={12} className="text-primary" />
                            </Pressable>
                          </View>
                        )}

                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-10 w-10 rounded-full items-center justify-center web:hover:bg-muted active:bg-muted"
                            >
                              <MoreHorizontal size={18} className="text-muted-foreground" />
                            </Button>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Content side="top" align="start" collisionPadding={8}>
                            {/* The capability switches. Every one of these
                                changes what the request CARRIES: web search
                                withholds three tools, deep research diverts the
                                turn into the multi-step research engine, agent
                                adds the delegation tools, ghost keeps the turn
                                out of the conversation list.

                                "Thinking mode" is gone from this menu on
                                purpose — it was a capability switch standing in
                                for a setting, and the effort control beside the
                                model picker is where that setting lives now. */}
                            <DropdownMenu.CheckboxItem
                              key="web-search"
                              value={webSearch ? 'on' : 'off'}
                              onValueChange={handleWebSearch}
                            >
                              <DropdownMenu.ItemIcon ios={{ name: "globe" }} />
                              <DropdownMenu.ItemTitle>Web search</DropdownMenu.ItemTitle>
                            </DropdownMenu.CheckboxItem>
                            <DropdownMenu.CheckboxItem
                              key="deep-research"
                              value={activeModes.has('deepResearch') ? 'on' : 'off'}
                              onValueChange={() => toggleMode('deepResearch')}
                            >
                              <DropdownMenu.ItemIcon ios={{ name: "magnifyingglass" }} />
                              <DropdownMenu.ItemTitle>Deep research</DropdownMenu.ItemTitle>
                            </DropdownMenu.CheckboxItem>
                            {isMainScreen && (
                              <DropdownMenu.CheckboxItem
                                key="ghost"
                                value={activeModes.has('ghost') ? 'on' : 'off'}
                                onValueChange={() => toggleMode('ghost')}
                              >
                                <DropdownMenu.ItemIcon ios={{ name: "eye.slash" }} />
                                <DropdownMenu.ItemTitle>Ghost mode</DropdownMenu.ItemTitle>
                              </DropdownMenu.CheckboxItem>
                            )}
                            <DropdownMenu.CheckboxItem
                              key="agent"
                              value={activeModes.has('agent') ? 'on' : 'off'}
                              onValueChange={() => toggleMode('agent')}
                            >
                              <DropdownMenu.ItemIcon ios={{ name: "cpu" }} />
                              <DropdownMenu.ItemTitle>Agent mode</DropdownMenu.ItemTitle>
                            </DropdownMenu.CheckboxItem>
                            {isNarrowScreen ? (
                              <>
                                <DropdownMenu.Separator />
                                {extraMenuItems}
                              </>
                            ) : (
                              <DropdownMenu.Sub>
                                <DropdownMenu.SubTrigger key="more">
                                  <DropdownMenu.ItemIcon ios={{ name: "ellipsis" }} />
                                  <DropdownMenu.ItemTitle>More</DropdownMenu.ItemTitle>
                                </DropdownMenu.SubTrigger>
                                <DropdownMenu.SubContent>
                                  {extraMenuItems}
                                </DropdownMenu.SubContent>
                              </DropdownMenu.Sub>
                            )}
                          </DropdownMenu.Content>
                        </DropdownMenu.Root>
                      </>
                    }
                  />
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
      {agentId && !showTerminal && activeModes.has('agent') && (
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
