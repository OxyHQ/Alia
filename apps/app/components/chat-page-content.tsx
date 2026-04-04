import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { View, Pressable, type TextInput } from "react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardStickyView } from "@/lib/keyboard";
import { LinearGradient } from "expo-linear-gradient";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { useStore } from "@/lib/globalStore";
import { Globe, X, Brain, Search, Menu, Plus, ArrowUp } from "lucide-react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { PromptInput, type Attachment } from "@/components/ui/prompt-input";
import { ScrollButton } from "@/components/ui/scroll-button";
import { ChatInterface } from "@/components/chat-interface";
import { ChatHeader } from "@/components/chat-header";
import { ChatTextInput } from "@/components/ui/chat-text-input";
import type { Message } from "@/types/chat";
import { toast } from "@/components/sonner";
import { AlertTriangle, Pencil } from "lucide-react-native";
import { CreditWarningBanner } from "@/components/credit-warning-banner";
import { ModelSelector, getThinkingModelId, isThinkingModel } from "@/components/model-selector";
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
import { useImagePicker } from "@/hooks/useImagePicker";
import { useDocumentPicker } from "@/hooks/useDocumentPicker";
import { cn } from "@/lib/utils";
import { Image } from "react-native";
import { useSearchSuggestions, useRecordSuggestionUsage } from "@/lib/hooks/use-suggestions";

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
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const [bottomBarHeight, setBottomBarHeight] = useState(160);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const hasMessages = messages.length > 0;
  const showConversationView = hasMessages || conversationLoading;

  // Landing page autocomplete: debounce input for search suggestions
  useEffect(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || trimmed.length < 2) {
      setDebouncedQuery("");
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(trimmed), 200);
    return () => clearTimeout(timer);
  }, [inputValue]);

  const { data: searchSuggestions } = useSearchSuggestions(debouncedQuery);
  const { mutate: recordUsage } = useRecordSuggestionUsage();

  const completions = useMemo(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || trimmed.length < 2 || !searchSuggestions?.length) return [];

    const lower = trimmed.toLowerCase();
    const results: Array<{ text: string; matchStart: number; matchEnd: number; suggestionId?: string }> = [];
    const seen = new Set<string>();

    for (const s of searchSuggestions) {
      if (results.length >= 6) break;
      const textLower = s.text.toLowerCase();
      if (seen.has(textLower)) continue;
      seen.add(textLower);

      const idx = textLower.indexOf(lower);
      results.push({
        text: s.text,
        matchStart: idx !== -1 ? idx : 0,
        matchEnd: idx !== -1 ? idx + trimmed.length : 0,
        suggestionId: s.suggestionId,
      });
    }

    return results;
  }, [searchSuggestions, inputValue]);

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

  const landingInputRef = useRef<TextInput>(null);
  const { pickImage } = useImagePicker();
  const { pickDocument } = useDocumentPicker();

  const handleAddPhotos = useCallback(async () => {
    const assets = await pickImage();
    if (assets && assets.length > 0) {
      assets.forEach((asset) => {
        addAttachment({
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          uri: asset.uri,
          type: "image",
          name: asset.name,
          size: asset.size,
          mimeType: asset.mimeType,
        });
      });
    }
  }, [addAttachment, pickImage]);

  const handleAddDocument = useCallback(async () => {
    const docs = await pickDocument();
    if (docs && docs.length > 0) {
      docs.forEach((doc) => {
        addAttachment({
          id: `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          uri: doc.uri,
          type: "document",
          name: doc.name,
          size: doc.size,
          mimeType: doc.mimeType,
        });
      });
    }
  }, [addAttachment, pickDocument]);

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
                      <View className="w-full">
                        <Pressable onPress={() => landingInputRef.current?.focus()}>
                          <View className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
                            {/* Attachments preview */}
                            {attachments.length > 0 && (
                              <View className="px-3 pt-3 flex-row flex-wrap gap-2">
                                {attachments.map((att) => (
                                  <View key={att.id} className="relative">
                                    {att.type === "image" ? (
                                      <Image source={{ uri: att.uri }} className="h-16 w-16 rounded-lg" />
                                    ) : (
                                      <View className="h-16 w-16 rounded-lg bg-muted items-center justify-center">
                                        <Text className="text-xs text-muted-foreground text-center px-1" numberOfLines={2}>{att.name}</Text>
                                      </View>
                                    )}
                                    <Pressable
                                      onPress={() => removeAttachment(att.id)}
                                      className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive items-center justify-center"
                                    >
                                      <X size={10} className="text-destructive-foreground" />
                                    </Pressable>
                                  </View>
                                ))}
                              </View>
                            )}

                            {/* Text input area */}
                            <View className="px-3 pt-3 pb-1">
                              <ChatTextInput
                                ref={landingInputRef}
                                value={inputValue}
                                onChangeText={setInputValue}
                                onSubmitEditing={handleSubmit}
                                onEnterPress={handleSubmit}
                                onImagePaste={handleImagePaste}
                                placeholder={disabled ? t("usageLimit.inputDisabledPlaceholder") : "Ask anything..."}
                                multiline
                                editable={!disabled}
                                className="w-full border-0 bg-transparent text-foreground text-base min-h-[48px] py-2 px-1"
                              />
                            </View>

                            {/* Action bar */}
                            <View className="px-3 pb-2.5 flex-row items-center justify-between">
                              <View className="flex-row items-center gap-1.5">
                                {/* Attach (+) button */}
                                <DropdownMenu.Root>
                                  <DropdownMenu.Trigger>
                                    <Pressable className="h-8 w-8 rounded-full items-center justify-center bg-muted">
                                      <Plus size={16} className="text-muted-foreground" />
                                    </Pressable>
                                  </DropdownMenu.Trigger>
                                  <DropdownMenu.Content side="top" align="start">
                                    <DropdownMenu.Item key="photos" onSelect={handleAddPhotos}>
                                      <DropdownMenu.ItemIcon ios={{ name: "photo" }} />
                                      <DropdownMenu.ItemTitle>Add photos</DropdownMenu.ItemTitle>
                                    </DropdownMenu.Item>
                                    <DropdownMenu.Item key="document" onSelect={handleAddDocument}>
                                      <DropdownMenu.ItemIcon ios={{ name: "doc" }} />
                                      <DropdownMenu.ItemTitle>Add document</DropdownMenu.ItemTitle>
                                    </DropdownMenu.Item>
                                  </DropdownMenu.Content>
                                </DropdownMenu.Root>

                                {/* Focus chip */}
                                <DropdownMenu.Root>
                                  <DropdownMenu.Trigger>
                                    <Pressable className="flex-row items-center h-8 rounded-full border border-dashed border-border px-3 gap-1.5 bg-transparent active:bg-muted">
                                      <Globe size={14} className="text-muted-foreground" />
                                      <Text className="text-sm text-muted-foreground">Focus</Text>
                                    </Pressable>
                                  </DropdownMenu.Trigger>
                                  <DropdownMenu.Content side="top" align="start" collisionPadding={8}>
                                    <DropdownMenu.CheckboxItem
                                      key="all"
                                      value={!activeModes.has("search") ? "on" : "off"}
                                      onValueChange={() => { if (activeModes.has("search")) toggleMode("search"); }}
                                    >
                                      <DropdownMenu.ItemIcon ios={{ name: "globe" }} />
                                      <DropdownMenu.ItemTitle>All</DropdownMenu.ItemTitle>
                                    </DropdownMenu.CheckboxItem>
                                    <DropdownMenu.CheckboxItem
                                      key="search"
                                      value={activeModes.has("search") ? "on" : "off"}
                                      onValueChange={() => toggleMode("search")}
                                    >
                                      <DropdownMenu.ItemIcon ios={{ name: "magnifyingglass" }} />
                                      <DropdownMenu.ItemTitle>Web Search</DropdownMenu.ItemTitle>
                                    </DropdownMenu.CheckboxItem>
                                  </DropdownMenu.Content>
                                </DropdownMenu.Root>

                                {/* Research chip */}
                                <Pressable
                                  onPress={() => toggleMode("deepResearch")}
                                  className={cn(
                                    "flex-row items-center h-8 rounded-full border border-dashed px-3 gap-1.5",
                                    activeModes.has("deepResearch")
                                      ? "border-primary bg-primary/10"
                                      : "border-border bg-transparent active:bg-muted"
                                  )}
                                >
                                  <Search size={14} className={activeModes.has("deepResearch") ? "text-primary" : "text-muted-foreground"} />
                                  <Text className={cn("text-sm", activeModes.has("deepResearch") ? "text-primary" : "text-muted-foreground")}>Research</Text>
                                </Pressable>
                              </View>

                              <View className="flex-row items-center gap-1.5">
                                {/* Model selector */}
                                <ModelSelector selectedModel={selectedModel} onModelChange={onModelChange} />

                                {/* Submit button */}
                                <Pressable
                                  onPress={handleSubmit}
                                  disabled={!inputValue.trim()}
                                  className={cn(
                                    "h-8 w-8 rounded-full items-center justify-center",
                                    inputValue.trim() ? "bg-primary" : "bg-muted"
                                  )}
                                >
                                  <ArrowUp size={16} className={inputValue.trim() ? "text-primary-foreground" : "text-muted-foreground"} />
                                </Pressable>
                              </View>
                            </View>
                          </View>
                        </Pressable>
                      </View>

                      {/* Autocomplete dropdown */}
                      {completions.length > 0 && (
                        <View className="mt-1 rounded-xl border border-border bg-card shadow-md overflow-hidden">
                          {completions.map((item) => (
                            <Pressable
                              key={item.suggestionId || item.text}
                              onPress={() => {
                                if (item.suggestionId) recordUsage(item.suggestionId);
                                setInputValue(item.text);
                                // Submit on next tick so inputValue state is updated
                                setTimeout(() => {
                                  onSubmit(item.text, attachments.length > 0 ? attachments : undefined);
                                  useStore.getState().clearAttachments();
                                }, 0);
                              }}
                              className="px-4 py-2.5 active:bg-muted flex-row items-center border-b border-border/30 last:border-b-0"
                            >
                              <Search size={14} className="text-muted-foreground mr-3 shrink-0" />
                              <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
                                <Text className="text-foreground">{item.text.slice(0, item.matchStart)}</Text>
                                <Text className="text-primary font-medium">{item.text.slice(item.matchStart, item.matchEnd)}</Text>
                                <Text className="text-foreground">{item.text.slice(item.matchEnd)}</Text>
                              </Text>
                              <ArrowUp size={14} className="text-muted-foreground ml-2 shrink-0 rotate-45" />
                            </Pressable>
                          ))}
                        </View>
                      )}
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
