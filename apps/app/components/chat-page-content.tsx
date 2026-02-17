import { useState, useCallback, useEffect } from "react";
import { View, Pressable, useWindowDimensions } from "react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import { LinearGradient } from "expo-linear-gradient";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { useStore } from "@/lib/globalStore";
import { Globe, MoreHorizontal, X, Ghost, Sparkles, Brain, Bot, Search, ShoppingBag, BookOpen } from "lucide-react-native";
import Entypo from "@expo/vector-icons/Entypo";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
  PromptInputMicButton,
  PromptInputAutocomplete,
  PromptInputAttachments,
  PromptInputSubmitButton,
  PromptInputAddMenu,
  type Attachment,
} from "@/components/ui/prompt-input";
import { ChatInterface } from "@/components/chat-interface";
import { ChatHeader } from "@/components/chat-header";
import { useAuth } from "@oxyhq/services";
import type { Message } from "@/types/chat";
import { toast } from "@/components/sonner";
import { VoiceChat } from "@/components/voice-chat";
import { CanvasPanel } from "@/components/canvas-panel";
import { AlertTriangle } from "lucide-react-native";
import { CreditWarningBanner } from "@/components/credit-warning-banner";
import { getThinkingModelId, isThinkingModel } from "@/components/model-selector";
import { useModelStore } from "@/lib/stores/model-store";
import { useEntitlements } from "@/lib/hooks/use-billing";
import { useCredits } from "@/lib/hooks/use-credits";
import { useRouter } from "expo-router";
import { useTranslation } from "@/hooks/useTranslation";

type Mode = 'search' | 'agent' | 'ghost' | 'deepResearch' | 'shoppingResearch' | 'study';

const MODE_CONFIG: Record<Mode, {
  label: string;
  icon: React.ComponentType<{ size: number; color: string }>;
  color: string;
  onToast: string;
  offToast: string;
  exclusive?: Mode[];
  featureId?: string;
}> = {
  search:           { label: 'modes.searchLabel',       icon: Globe,       color: '#3b82f6', onToast: 'modes.searchOn',           offToast: 'modes.searchOff' },
  ghost:            { label: 'modes.ghostLabel',        icon: Ghost,       color: '#00b2ff', onToast: 'modes.ghostOn',            offToast: 'modes.ghostOff' },
  agent:            { label: 'modes.agentLabel',        icon: Bot,         color: '#f97316', onToast: 'modes.agentOn',            offToast: 'modes.agentOff', featureId: 'agent-mode' },
  deepResearch:     { label: 'modes.deepResearchLabel', icon: Search,      color: '#10b981', onToast: 'modes.deepResearchOn',     offToast: 'modes.deepResearchOff', exclusive: ['shoppingResearch'], featureId: 'deep-research' },
  shoppingResearch: { label: 'modes.shoppingLabel',     icon: ShoppingBag, color: '#ec4899', onToast: 'modes.shoppingResearchOn', offToast: 'modes.shoppingResearchOff', exclusive: ['deepResearch'], featureId: 'shopping-research' },
  study:            { label: 'modes.studyLabel',        icon: BookOpen,    color: '#6366f1', onToast: 'modes.studyOn',            offToast: 'modes.studyOff' },
};

const MODE_ORDER: Mode[] = ['ghost', 'agent', 'deepResearch', 'shoppingResearch', 'study'];

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
  activeRole?: { id: string; name: string };
  onRemoveRole?: () => void;
  disabled?: boolean;
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
  messages,
  scrollViewRef,
  isLoading,
  onSubmit,
  onSuggestionPress,
  onEditMessage,
  onStop,
  onClear,
  selectedModel,
  onModelChange,
  activeRole,
  onRemoveRole,
  disabled = false,
}: ChatPageContentProps) => {
  const attachments = useStore((state) => state.attachments);
  const addAttachment = useStore((state) => state.addAttachment);
  const removeAttachment = useStore((state) => state.removeAttachment);
  const { isAuthenticated } = useAuth();
  const { data: entitlements } = useEntitlements();
  const { data: creditsInfo } = useCredits();
  const router = useRouter();
  const { t } = useTranslation();
  const { width: screenWidth } = useWindowDimensions();
  const isNarrowScreen = screenWidth < 640;
  const [activeModes, setActiveModes] = useState<Set<Mode>>(new Set());
  const thinkingMode = isThinkingModel(selectedModel);
  const baseModel = useModelStore((s) => s.baseModel);
  const setBaseModel = useModelStore((s) => s.setBaseModel);

  useEffect(() => {
    if (!isThinkingModel(selectedModel)) {
      setBaseModel(selectedModel);
    }
  }, [selectedModel, setBaseModel]);

  const [inputValue, setInputValue] = useState("");
  const [showVoice, setShowVoice] = useState(false);
  const [showCanvas, setShowCanvas] = useState(false);
  const [canvasComponents, setCanvasComponents] = useState<any[]>([]);
  const { colors } = useColorScheme();

  const [bottomBarHeight, setBottomBarHeight] = useState(160);
  const isMainScreen = messages.length === 0;

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
        config.exclusive?.forEach(m => next.delete(m as Mode));
        toast.info(t(config.onToast));
      }
      return next;
    });
  }, [entitlements, t, router]);

  const handleSubmit = () => {
    if (!inputValue.trim() || isLoading || disabled) return;
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
      toast.info(t('modes.thinkingOff'));
    } else {
      onModelChange(getThinkingModelId());
      toast.info(t('modes.thinkingOn'));
    }
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
    setShowCanvas(true);
  };


  const extraMenuItems = (
    <>
      <DropdownMenu.Item key="sources" onSelect={handleAddSources}>
        <DropdownMenu.ItemIcon ios={{ name: "link" }} />
        <DropdownMenu.ItemTitle>Add sources</DropdownMenu.ItemTitle>
      </DropdownMenu.Item>
      <DropdownMenu.CheckboxItem
        key="study"
        value={activeModes.has('study') ? 'on' : 'off'}
        onValueChange={() => toggleMode('study')}
      >
        <DropdownMenu.ItemIcon ios={{ name: "book" }} />
        <DropdownMenu.ItemTitle>Study and learn</DropdownMenu.ItemTitle>
      </DropdownMenu.CheckboxItem>
      <DropdownMenu.CheckboxItem
        key="search"
        value={activeModes.has('search') ? 'on' : 'off'}
        onValueChange={() => toggleMode('search')}
      >
        <DropdownMenu.ItemIcon ios={{ name: "globe" }} />
        <DropdownMenu.ItemTitle>Web search</DropdownMenu.ItemTitle>
      </DropdownMenu.CheckboxItem>
      <DropdownMenu.Item key="canvas" onSelect={handleCanvas}>
        <DropdownMenu.ItemIcon ios={{ name: "pencil.tip" }} />
        <DropdownMenu.ItemTitle>Canvas</DropdownMenu.ItemTitle>
      </DropdownMenu.Item>
    </>
  );

  return (
    <View className="flex-1 bg-background">
      <View className="flex-1 relative">
        <ChatInterface
          messages={messages}
          scrollViewRef={scrollViewRef}
          isLoading={isLoading}
          onSuggestionPress={handleSuggestionPress}
          onEditMessage={onEditMessage}
          bottomPadding={bottomBarHeight}
        />

        <LinearGradient
          colors={[colors.background, "transparent"]}
          locations={[0.1, 1]}
          pointerEvents="box-none"
          style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 10, paddingBottom: 32 }}
        >
          <ChatHeader
            title="Alia"
            selectedModel={selectedModel}
            onModelChange={onModelChange}
            onGhostModePress={() => toggleMode('ghost')}
            ghostModeActive={activeModes.has('ghost')}
            onClear={onClear}
            isConversation={messages.length > 0}
          />
        </LinearGradient>

        <LinearGradient
          colors={["transparent", colors.background]}
          locations={[0, 0.9]}
          style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10, paddingTop: 24 }}
          onLayout={(e) => setBottomBarHeight(e.nativeEvent.layout.height)}
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

          <View className="p-4">
            <View className="mx-auto w-full max-w-3xl">
                <PromptInput
                  value={inputValue}
                  onValueChange={setInputValue}
                  onSubmit={handleSubmit}
                  isLoading={isLoading}
                  disabled={isLoading || disabled}
                  attachments={attachments}
                  onAddAttachment={addAttachment}
                  onRemoveAttachment={removeAttachment}
                  onImagePaste={handleImagePaste}
                >
                  <PromptInputAutocomplete enabled={isMainScreen} />
                  <PromptInputAttachments />

                  <PromptInputTextarea
                    value={inputValue}
                    onChangeText={setInputValue}
                    placeholder={disabled ? t('usageLimit.inputDisabledPlaceholder') : "Message Alia..."}
                    editable={!disabled}
                    className="min-h-[44px] text-base md:text-base py-3"
                  />
                  <PromptInputActions className="flex-row items-center justify-between gap-2 mt-2 mb-1 px-3">
                    <View className="flex-row items-center gap-1.5">
                      <PromptInputAddMenu />
                      <Button
                        variant={activeModes.has('search') ? "default" : "outline"}
                        className="h-8 rounded-full px-3 flex-row items-center gap-2 text-muted-foreground hover:text-foreground font-normal text-xs"
                        onPress={() => toggleMode('search')}
                      >
                        <Globe size={16} className={activeModes.has('search') ? "text-primary-foreground" : "text-muted-foreground"} />
                      </Button>

                      {thinkingMode && (
                        <ModeChip
                          icon={Brain}
                          label={t('modes.thinkingLabel')}
                          color="#a855f7"
                          onDismiss={handleThinkingMode}
                        />
                      )}

                      {MODE_ORDER.map(mode =>
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
                        <View className="h-8 rounded-full px-3 bg-primary/10 flex-row items-center gap-1.5">
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
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                          >
                            <MoreHorizontal size={16} className="text-muted-foreground" />
                          </Button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Content side="top" align="start" collisionPadding={8}>
                          <DropdownMenu.Sub>
                            <DropdownMenu.SubTrigger key="research">
                              <DropdownMenu.ItemIcon ios={{ name: "magnifyingglass" }} />
                              <DropdownMenu.ItemTitle>Research</DropdownMenu.ItemTitle>
                            </DropdownMenu.SubTrigger>
                            <DropdownMenu.SubContent>
                              <DropdownMenu.CheckboxItem
                                key="deep-research"
                                value={activeModes.has('deepResearch') ? 'on' : 'off'}
                                onValueChange={() => toggleMode('deepResearch')}
                              >
                                <DropdownMenu.ItemIcon ios={{ name: "magnifyingglass" }} />
                                <DropdownMenu.ItemTitle>Deep research</DropdownMenu.ItemTitle>
                              </DropdownMenu.CheckboxItem>
                              <DropdownMenu.CheckboxItem
                                key="shopping"
                                value={activeModes.has('shoppingResearch') ? 'on' : 'off'}
                                onValueChange={() => toggleMode('shoppingResearch')}
                              >
                                <DropdownMenu.ItemIcon ios={{ name: "bag" }} />
                                <DropdownMenu.ItemTitle>Shopping research</DropdownMenu.ItemTitle>
                              </DropdownMenu.CheckboxItem>
                            </DropdownMenu.SubContent>
                          </DropdownMenu.Sub>
                          <DropdownMenu.CheckboxItem
                            key="thinking"
                            value={thinkingMode ? 'on' : 'off'}
                            onValueChange={handleThinkingMode}
                          >
                            <DropdownMenu.ItemIcon ios={{ name: "brain" }} />
                            <DropdownMenu.ItemTitle>Thinking mode</DropdownMenu.ItemTitle>
                          </DropdownMenu.CheckboxItem>
                          <DropdownMenu.CheckboxItem
                            key="ghost"
                            value={activeModes.has('ghost') ? 'on' : 'off'}
                            onValueChange={() => toggleMode('ghost')}
                          >
                            <DropdownMenu.ItemIcon ios={{ name: "eye.slash" }} />
                            <DropdownMenu.ItemTitle>Ghost mode</DropdownMenu.ItemTitle>
                          </DropdownMenu.CheckboxItem>
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
                    </View>

                    <View className="flex-row items-center gap-1.5">
                      <PromptInputMicButton />
                      <PromptInputSubmitButton
                        isLoading={isLoading}
                        onStop={onStop}
                        emptyAction={
                          <Button
                            size="icon"
                            variant="outline"
                            className="h-8 w-8 rounded-full"
                            onPress={() => {
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
                              setShowVoice(true);
                            }}
                          >
                            <Entypo name="modern-mic" size={16} className="text-muted-foreground" />
                          </Button>
                        }
                      />
                    </View>
                  </PromptInputActions>
                </PromptInput>
            </View>
          </View>
        </LinearGradient>
      </View>

      <VoiceChat visible={showVoice} onClose={() => setShowVoice(false)} />
      <CanvasPanel visible={showCanvas} onClose={() => setShowCanvas(false)} components={canvasComponents} />
    </View>
  );
};
