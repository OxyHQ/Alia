import { useState, useCallback, useEffect } from "react";
import { View, Pressable } from "react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardStickyView } from "@/lib/keyboard";
import { LinearGradient } from "expo-linear-gradient";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { useStore } from "@/lib/globalStore";
import { Globe, X, Brain, Search, Menu, Plus } from "lucide-react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { PromptInput, type Attachment } from "@/components/ui/prompt-input";
import { ScrollButton } from "@/components/ui/scroll-button";
import { ChatInterface } from "@/components/chat-interface";
import { ChatHeader } from "@/components/chat-header";
import type { Message } from "@/types/chat";
import { toast } from "@/components/sonner";
import { AlertTriangle, Pencil } from "lucide-react-native";
import { CreditWarningBanner } from "@/components/credit-warning-banner";
import { getThinkingModelId, isThinkingModel } from "@/components/model-selector";
import { useModelStore } from "@/lib/stores/model-store";
import { useEntitlements } from "@/lib/hooks/use-billing";
import { useRouter } from "expo-router";
import { useTranslation } from "@/hooks/useTranslation";
import { WelcomeMessage } from "@/components/welcome-message";
import { ClarityWordmark } from "@/components/ui/clarity-wordmark";
import { useNavigation } from "expo-router";
import { DrawerNavigationProp } from "@react-navigation/drawer";
import { useWindowDimensions } from "react-native";
import { ScrollView } from "react-native";

type Mode = "search" | "deepResearch";

const MODE_CONFIG: Record<Mode, {
  label: string;
  icon: React.ComponentType<{ size: number; color: string }>;
  color: string;
  onToast: string;
  offToast: string;
  featureId?: string;
}> = {
  search: {
    label: "modes.searchLabel",
    icon: Globe,
    color: "#3b82f6",
    onToast: "modes.searchOn",
    offToast: "modes.searchOff",
  },
  deepResearch: {
    label: "modes.deepResearchLabel",
    icon: Search,
    color: "#10b981",
    onToast: "modes.deepResearchOn",
    offToast: "modes.deepResearchOff",
    featureId: "deep-research",
  },
};

interface ChatPageContentProps {
  messages: Message[];
  scrollViewRef: React.RefObject<GHScrollView>;
  isLoading: boolean;
  onSubmit: (value: string, attachments?: Attachment[]) => void;
  onSuggestionPress: (message: string) => void;
  onEditMessage: (messageId: string, newContent: string) => void;
  onStop?: () => void;
  onClear?: () => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  disabled?: boolean;
  conversationLoading?: boolean;
}

const ModeChip = ({ icon: Icon, label, color, onDismiss }: {
  icon: React.ComponentType<{ size: number; color: string }>;
  label: string;
  color: string;
  onDismiss: () => void;
}) => (
  <View className="h-8 rounded-full px-3 flex-row items-center gap-1.5" style={{ backgroundColor: `${color}20` }}>
    <Icon size={14} color={color} />
    <Text className="text-xs font-medium" style={{ color }}>{label}</Text>
    <Pressable onPress={onDismiss} className="active:opacity-70">
      <X size={12} color={color} />
    </Pressable>
  </View>
);

export const ChatPageContent = ({
  messages, scrollViewRef, isLoading, onSubmit, onSuggestionPress,
  onEditMessage, onStop, onClear, selectedModel, onModelChange,
  disabled = false, conversationLoading,
}: ChatPageContentProps) => {
  const attachments = useStore((state) => state.attachments);
  const addAttachment = useStore((state) => state.addAttachment);
  const removeAttachment = useStore((state) => state.removeAttachment);
  const { data: entitlements } = useEntitlements();
  const router = useRouter();
  const { t } = useTranslation();
  const [activeModes, setActiveModes] = useState<Set<Mode>>(new Set());
  const thinkingMode = isThinkingModel(selectedModel);
  const baseModel = useModelStore((s) => s.baseModel);
  const setBaseModel = useModelStore((s) => s.setBaseModel);
  const navigation = useNavigation<DrawerNavigationProp<never>>();
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;

  useEffect(() => {
    if (!isThinkingModel(selectedModel)) {
      setBaseModel(selectedModel);
    }
  }, [selectedModel, setBaseModel]);

  const [inputValue, setInputValue] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const [bottomBarHeight, setBottomBarHeight] = useState(160);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const hasMessages = messages.length > 0;
  const showConversationView = hasMessages || conversationLoading;

  const handleScrollToBottom = useCallback(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [scrollViewRef]);

  const toggleMode = useCallback((mode: Mode) => {
    const config = MODE_CONFIG[mode];
    if (config.featureId && !entitlements?.features[config.featureId]) {
      toast.info(t("subscribe.featureRequiresPlan", { feature: t(config.label) }));
      router.push("/(biglayout)/subscribe");
      return;
    }
    setActiveModes((prev) => {
      const next = new Set(prev);
      if (next.has(mode)) {
        next.delete(mode);
        toast.info(t(config.offToast));
      } else {
        next.add(mode);
        toast.info(t(config.onToast));
      }
      if (mode === "deepResearch") {
        useStore.getState().setDeepResearchMode(next.has("deepResearch"));
      }
      return next;
    });
  }, [entitlements, t, router]);

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

  const handleSuggestionPress = useCallback((message: string) => {
    if (isLoading) return;
    onSuggestionPress(message);
  }, [isLoading, onSuggestionPress]);

  const handleThinkingMode = () => {
    if (thinkingMode) {
      onModelChange(baseModel);
      toast.info(t("modes.thinkingOff"));
    } else {
      onModelChange(getThinkingModelId());
      toast.info(t("modes.thinkingOn"));
    }
  };

  const handleImagePaste = useCallback((files: File[]) => {
    files.forEach((file) => {
      const id = `paste-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      addAttachment({
        id, uri: "", type: "image",
        name: file.name || "Pasted image",
        size: file.size || 0,
        mimeType: file.type || "image/png",
        isLoading: true,
      });
      const reader = new FileReader();
      reader.onload = () => {
        useStore.getState().updateAttachment(id, { uri: reader.result as string, isLoading: false });
      };
      reader.readAsDataURL(file);
    });
  }, [addAttachment]);

  const actionsLeftContent = (
    <>
      <Button
        variant={activeModes.has("search") ? "default" : "outline"}
        className="h-8 rounded-full px-3 flex-row items-center gap-2 text-muted-foreground hover:text-foreground font-normal text-xs"
        onPress={() => toggleMode("search")}
      >
        <Globe size={16} className={activeModes.has("search") ? "text-primary-foreground" : "text-muted-foreground"} />
      </Button>

      {thinkingMode && (
        <ModeChip icon={Brain} label={t("modes.thinkingLabel")} color="#a855f7" onDismiss={handleThinkingMode} />
      )}

      {activeModes.has("deepResearch") && (
        <ModeChip
          icon={MODE_CONFIG.deepResearch.icon}
          label={t(MODE_CONFIG.deepResearch.label)}
          color={MODE_CONFIG.deepResearch.color}
          onDismiss={() => toggleMode("deepResearch")}
        />
      )}

      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <Button variant="outline" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground">
            <Search size={16} className="text-muted-foreground" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="top" align="start" collisionPadding={8}>
          <DropdownMenu.CheckboxItem
            key="deep-research"
            value={activeModes.has("deepResearch") ? "on" : "off"}
            onValueChange={() => toggleMode("deepResearch")}
          >
            <DropdownMenu.ItemIcon ios={{ name: "magnifyingglass" }} />
            <DropdownMenu.ItemTitle>Deep research</DropdownMenu.ItemTitle>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            key="thinking"
            value={thinkingMode ? "on" : "off"}
            onValueChange={handleThinkingMode}
          >
            <DropdownMenu.ItemIcon ios={{ name: "brain" }} />
            <DropdownMenu.ItemTitle>Thinking mode</DropdownMenu.ItemTitle>
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </>
  );

  // Landing-page-specific actions for the search box grid layout
  const landingActionsLeft = (
    <>
      {/* Attach button */}
      <Pressable
        className="h-8 rounded-full aspect-square items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent"
        onPress={() => toggleMode("search")}
      >
        <Plus size={16} className={activeModes.has("search") ? "text-primary" : "text-muted-foreground"} />
      </Pressable>

      {/* Focus chip */}
      <Pressable
        className="inline-flex select-none h-8 max-w-full flex-row items-center border text-sm transition-colors duration-150 cursor-pointer rounded-full gap-1 pl-2 pr-3 border-dashed bg-transparent border-border hover:bg-muted"
        onPress={() => toggleMode("search")}
      >
        <Globe size={14} className={activeModes.has("search") ? "text-primary" : "text-muted-foreground"} />
        <Text className="text-sm text-muted-foreground truncate">Focus</Text>
      </Pressable>

      {thinkingMode && (
        <ModeChip icon={Brain} label={t("modes.thinkingLabel")} color="#a855f7" onDismiss={handleThinkingMode} />
      )}

      {activeModes.has("deepResearch") && (
        <ModeChip
          icon={MODE_CONFIG.deepResearch.icon}
          label={t(MODE_CONFIG.deepResearch.label)}
          color={MODE_CONFIG.deepResearch.color}
          onDismiss={() => toggleMode("deepResearch")}
        />
      )}
    </>
  );

  // ---- Conversation view: messages + sticky bottom input ----
  if (showConversationView) {
    return (
      <View className="relative flex h-full flex-col bg-background">
        <View className="relative flex-1 overflow-hidden">
          <ChatInterface
            messages={messages}
            scrollViewRef={scrollViewRef}
            isLoading={isLoading}
            conversationLoading={conversationLoading}
            onSuggestionPress={handleSuggestionPress}
            onStartEdit={handleStartEdit}
            bottomPadding={bottomBarHeight}
            onAtBottomChange={setIsAtBottom}
          />

          <LinearGradient
            colors={[colors.background, "transparent"]}
            locations={[0.1, 1]}
            style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 10, paddingBottom: 32, pointerEvents: "box-none" }}
          >
            <ChatHeader
              title="Clarity"
              selectedModel={selectedModel}
              onModelChange={onModelChange}
              onClear={onClear}
              isConversation
            />
          </LinearGradient>

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
                <View className="mx-auto w-full max-w-screen-md px-4 pb-1">
                  <View className="flex-row items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2">
                    <AlertTriangle size={14} className="text-destructive" />
                    <Text className="text-xs text-destructive flex-1">{t("usageLimit.limitReachedBanner")}</Text>
                  </View>
                </View>
              )}

              <View className="mx-auto w-full max-w-screen-md px-4 md:px-6 py-3">
                <View className="relative">
                  <View style={{ position: "absolute", top: -48, right: 0, zIndex: -1 }}>
                    <ScrollButton isAtBottom={isAtBottom} onScrollToBottom={handleScrollToBottom} />
                  </View>
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
                    leadingAddMenu
                    placeholder={disabled ? t("usageLimit.inputDisabledPlaceholder") : "Ask anything..."}
                    onStop={onStop}
                    actionsLeft={actionsLeftContent}
                  />
                </View>
              </View>
            </LinearGradient>
          </KeyboardStickyView>
        </View>
      </View>
    );
  }

  // ---- Landing: centered search page ----
  return (
    <View className="isolate flex h-auto max-h-screen min-w-0 grow flex-col">
      <View className="relative isolate min-h-0 flex-1 overflow-hidden bg-background">
        <View className="mx-auto flex w-full flex-col h-full">
          {/* Scrollable container */}
          <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1 }}>
            <View className="mx-auto w-full max-w-screen-md px-4 md:px-6 h-full">
              <View className="mx-auto w-full sm:max-w-screen-md h-full">
                <View className="relative flex h-full flex-col">

                  {/* Mobile header (hidden on desktop) */}
                  {!isLargeScreen && (
                    <View className="py-4 pr-4 pl-1 h-14 flex-row items-center justify-between border-b -mx-4 border-border/50">
                      <View className="gap-x-1 flex-row items-center">
                        <Pressable
                          onPress={() => navigation.toggleDrawer()}
                          className="h-9 w-9 items-center justify-center rounded-full"
                        >
                          <Menu size={20} className="text-muted-foreground" />
                        </Pressable>
                      </View>
                    </View>
                  )}

                  {/* Search section (vertically centered) */}
                  <View className="w-full grow flex-col items-center pb-[10vh] md:mt-0 md:flex z-10">
                    {/* Spacer pushes content to center on desktop */}
                    <View className="hidden shrink-0 md:flex md:h-[40vh]" />

                    {/* Search wrapper */}
                    <View className="px-4 relative flex w-full flex-col justify-center md:h-auto md:px-0">

                      {/* Logo area */}
                      <View className="mb-6 flex w-full items-center justify-center pb-3">
                        <ClarityWordmark height={40} />
                      </View>

                      {/* Search input box */}
                      <View className="w-full relative">
                        <View className="bg-background rounded-2xl">
                          <View className="relative rounded-2xl bg-background">
                            <View className="bg-card w-full border rounded-2xl duration-75 transition-all border-border shadow-sm px-0 pt-3 pb-3">
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
                                autocompletePosition="bottom"
                                placeholder={disabled ? t("usageLimit.inputDisabledPlaceholder") : "Ask anything..."}
                                onStop={onStop}
                                className="border-0 rounded-none bg-transparent shadow-none"
                                actionsLeft={landingActionsLeft}
                              />
                            </View>
                          </View>
                        </View>
                      </View>
                    </View>

                    {/* Category tabs + suggestion cards below search */}
                    <View className="mt-4 w-full hidden md:flex">
                      <View className="mt-6 w-full">
                        <WelcomeContent onSuggestionPress={handleSuggestionPress} />
                      </View>
                    </View>

                    {/* Mobile: show welcome below search without absolute positioning */}
                    {!isLargeScreen && (
                      <View className="mt-4 w-full px-4 md:hidden">
                        <WelcomeContent onSuggestionPress={handleSuggestionPress} />
                      </View>
                    )}

                  </View>
                </View>
              </View>
            </View>
          </ScrollView>
        </View>
      </View>
    </View>
  );
};

function WelcomeContent({ onSuggestionPress }: { onSuggestionPress: (msg: string) => void }) {
  return <WelcomeMessage onSuggestionPress={onSuggestionPress} />;
}
