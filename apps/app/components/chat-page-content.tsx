import { useState, useCallback, useRef } from "react";
import { View, Pressable, useWindowDimensions } from "react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import { LinearGradient } from "expo-linear-gradient";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { useStore } from "@/lib/globalStore";
import { ActivityIndicator } from "react-native";
import { Plus, Globe, ArrowUp, MoreHorizontal, X, Ghost, Sparkles, Square, Brain, Mic, MicOff, Bot, Search, ShoppingBag, BookOpen } from "lucide-react-native";
import Entypo from '@expo/vector-icons/Entypo';
import { useImagePicker } from "@/hooks/useImagePicker";
import { useDocumentPicker } from "@/hooks/useDocumentPicker";
import { AttachmentPreview } from "@/components/attachment-preview";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { PromptInput, PromptInputTextarea, PromptInputActions, usePromptInput } from "@/components/ui/prompt-input";
import { ChatInterface } from "@/components/chat-interface";
import { ChatHeader } from "@/components/chat-header";
import { useAuth } from "@oxyhq/services";
import type { Message } from "@/types/chat";
import { toast } from "@/components/sonner";
import { VoiceChat } from "@/components/voice-chat";
import { CanvasPanel } from "@/components/canvas-panel";
import { useSpeechToText } from "@/lib/hooks/use-speech-to-text";
import { AlertTriangle } from "lucide-react-native";
import { CreditWarningBanner } from "@/components/credit-warning-banner";
import { PromptAutocomplete } from "@/components/prompt-autocomplete";
import { usePromptCompletions } from "@/hooks/usePromptCompletions";
import type { PromptCompletion } from "@/lib/prompt-completions";
import { getThinkingModelId, isThinkingModel } from "@/components/model-selector";

interface ChatPageContentProps {
  messages: Message[];
  scrollViewRef: React.RefObject<GHScrollView>;
  isLoading: boolean;
  onSubmit: (value: string) => void;
  onSuggestionPress: (message: string) => void;
  onEditMessage: (messageId: string, newContent: string) => void;
  onStop?: () => void;
  onClear?: () => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  activeRole?: { id: string; name: string };
  onRemoveRole?: () => void;
  thinkingMode?: boolean;
  disabled?: boolean;
}

const SubmitButtonWrapper = ({
  isLoading,
  stop,
  inputValue,
  attachments,
  onVoicePress,
}: {
  isLoading: boolean;
  stop?: () => void;
  inputValue: string;
  attachments: any[];
  onVoicePress?: () => void;
}) => {
  const { onSubmit } = usePromptInput();
  const hasContent = inputValue.trim() || attachments.length > 0;

  if (isLoading) {
    return (
      <Button size="icon" onPress={stop} className="h-8 w-8 rounded-full">
        <Square size={12} color="white" className="fill-current" />
      </Button>
    );
  }

  if (!hasContent) {
    return (
      <Button size="icon" onPress={onVoicePress} className="h-8 w-8 rounded-full">
        <Entypo name="sound" size={16} color="white" />
      </Button>
    );
  }

  return (
    <Button size="icon" onPress={onSubmit} className="h-8 w-8 rounded-full">
      <ArrowUp size={16} color="white" />
    </Button>
  );
};

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
  thinkingMode = false,
  disabled = false,
}: ChatPageContentProps) => {
  const attachments = useStore((state) => state.attachments);
  const { isAuthenticated } = useAuth();
  const { width: screenWidth } = useWindowDimensions();
  const isNarrowScreen = screenWidth < 640;
  const [searchMode, setSearchMode] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [ghostMode, setGhostMode] = useState(false);
  const [deepResearchMode, setDeepResearchMode] = useState(false);
  const [shoppingResearchMode, setShoppingResearchMode] = useState(false);
  const [studyMode, setStudyMode] = useState(false);
  const previousModelRef = useRef(selectedModel);
  const [inputValue, setInputValue] = useState("");
  const [showVoice, setShowVoice] = useState(false);
  const [showCanvas, setShowCanvas] = useState(false);
  const [canvasComponents, setCanvasComponents] = useState<any[]>([]);
  const { pickImage } = useImagePicker();
  const { pickDocument } = useDocumentPicker();
  const stt = useSpeechToText();
  const { colors } = useColorScheme();
  const [bottomBarHeight, setBottomBarHeight] = useState(160);
  const isMainScreen = messages.length === 0;
  const completions = usePromptCompletions(inputValue, isMainScreen);

  const handleAutocompleteSelect = useCallback((completion: PromptCompletion) => {
    setInputValue(completion.text);
  }, []);

  const handleSubmit = () => {
    if (!inputValue.trim() || isLoading || disabled) return;
    onSubmit(inputValue);
    setInputValue("");
    useStore.getState().clearAttachments();
  };

  const handleSuggestionPress = useCallback((message: string) => {
    if (isLoading) return;
    onSuggestionPress(message);
  }, [isLoading, onSuggestionPress]);

  const handleAddPhotos = async () => {
    if (!isAuthenticated) {
      toast.error('Please sign in to upload images.');
      return;
    }

    try {
      const assets = await pickImage();
      if (assets && assets.length > 0) {
        assets.forEach((asset) => {
          useStore.getState().addAttachment({
            id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            uri: asset.uri,
            type: 'image',
            name: asset.name,
            size: asset.size,
            mimeType: asset.mimeType,
          });
        });
      }
    } catch (err) {
      console.error('Error picking images:', err);
    }
  };

  const handleAddDocument = async () => {
    if (!isAuthenticated) {
      toast.error('Please sign in to upload documents.');
      return;
    }

    try {
      const docs = await pickDocument();
      if (docs && docs.length > 0) {
        docs.forEach((doc) => {
          useStore.getState().addAttachment({
            id: `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            uri: doc.uri,
            type: 'document',
            name: doc.name,
            size: doc.size,
            mimeType: doc.mimeType,
          });
        });
      }
    } catch (err) {
      console.error('Error picking documents:', err);
      toast.error('Failed to pick documents. Please try again.');
    }
  };

  const handleRemoveAttachment = (id: string) => {
    useStore.getState().removeAttachment(id);
  };

  const handleImagePaste = async (files: File[]) => {
    if (!isAuthenticated) {
      toast.error('Please sign in to paste images.');
      return;
    }

    try {
      for (const file of files) {
        const attachmentId = `paste-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        useStore.getState().addAttachment({
          id: attachmentId,
          uri: '',
          type: 'image',
          name: file.name || 'Pasted image',
          size: file.size || 0,
          mimeType: file.type || 'image/png',
          isLoading: true,
        });

        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target?.result as string;
          if (dataUrl) {
            useStore.getState().updateAttachment(attachmentId, {
              uri: dataUrl,
              isLoading: false,
            });
          }
        };
        reader.onerror = () => {
          useStore.getState().removeAttachment(attachmentId);
        };
        reader.readAsDataURL(file);
      }
    } catch (err) {
      console.error('Error handling pasted images:', err);
      toast.error('Failed to process pasted images. Please try again.');
    }
  };

  const handleSearchToggle = () => {
    const newValue = !searchMode;
    setSearchMode(newValue);
    toast.info(newValue ? 'Web search will be used' : 'Search mode disabled');
  };

  const handleDeepResearch = () => {
    const newValue = !deepResearchMode;
    setDeepResearchMode(newValue);
    if (newValue) setShoppingResearchMode(false); // mutually exclusive
    toast.info(newValue ? 'Deep research mode activated' : 'Deep research disabled');
  };

  const handleShoppingResearch = () => {
    const newValue = !shoppingResearchMode;
    setShoppingResearchMode(newValue);
    if (newValue) setDeepResearchMode(false); // mutually exclusive
    toast.info(newValue ? 'Shopping research activated' : 'Shopping research disabled');
  };

  const handleAgentMode = () => {
    const newValue = !agentMode;
    setAgentMode(newValue);
    toast.info(newValue ? 'I can now perform actions autonomously' : 'Agent mode disabled');
  };

  const handleGhostMode = () => {
    const newValue = !ghostMode;
    setGhostMode(newValue);
    toast.info(newValue ? 'Conversations will not be saved' : 'Conversations will be saved normally');
  };

  const handleThinkingMode = () => {
    if (thinkingMode) {
      // Turn off: restore previous model
      onModelChange(previousModelRef.current);
      toast.info('Thinking mode disabled');
    } else {
      // Turn on: save current model and switch to thinking variant
      if (!isThinkingModel(selectedModel)) {
        previousModelRef.current = selectedModel;
      }
      onModelChange(getThinkingModelId());
      toast.info('AI will show its reasoning process');
    }
  };

  const handleAddSources = () => {
    toast.info('You can add URLs, documents, or other sources for me to reference.');
  };

  const handleStudyAndLearn = () => {
    const newValue = !studyMode;
    setStudyMode(newValue);
    toast.info(newValue ? 'Study mode activated' : 'Study mode disabled');
  };

  const handleWebSearch = () => {
    handleSearchToggle();
  };

  const handleCanvas = () => {
    setShowCanvas(true);
  };

  const handleMicPress = async () => {
    if (stt.isRecording) {
      const text = await stt.stopAndTranscribe();
      if (text) {
        setInputValue((prev) => (prev ? `${prev} ${text}` : text));
      }
    } else if (stt.isTranscribing) {
      // Already transcribing, do nothing
    } else {
      stt.startRecording();
    }
  };

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
            onGhostModePress={handleGhostMode}
            ghostModeActive={ghostMode}
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

          {/* Disabled banner when limit hit */}
          {disabled && (
            <View className="mx-auto w-full max-w-3xl px-4 pb-1">
              <View className="flex-row items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2">
                <AlertTriangle size={14} className="text-destructive" />
                <Text className="text-xs text-destructive flex-1">
                  Usage limit reached. Upgrade or wait to continue.
                </Text>
              </View>
            </View>
          )}

          <View className="p-4">
            <View className="mx-auto w-full max-w-3xl flex-row items-end gap-2">
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 rounded-full text-muted-foreground hover:text-foreground"
                  >
                    <Plus size={20} className="text-muted-foreground" />
                  </Button>
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
              <View className="flex-1">
                {isMainScreen && (
                  <PromptAutocomplete
                    completions={completions}
                    onSelect={handleAutocompleteSelect}
                  />
                )}
                <PromptInput
                  value={inputValue}
                  onValueChange={setInputValue}
                  onSubmit={handleSubmit}
                  isLoading={isLoading}
                  disabled={isLoading || disabled}
                  onImagePaste={handleImagePaste}
                >
                  <AttachmentPreview
                    attachments={attachments}
                    onRemove={handleRemoveAttachment}
                  />

                  <PromptInputTextarea
                    value={inputValue}
                    onChangeText={setInputValue}
                    placeholder={disabled ? "Usage limit reached" : "Message Alia..."}
                    editable={!disabled}
                    className="min-h-[44px] text-base md:text-base py-3"
                  />
                  <PromptInputActions className="flex-row items-center justify-between gap-2 mt-2 mb-1 px-3">
                    <View className="flex-row items-center gap-1.5">
                      <Button
                        variant={searchMode ? "default" : "outline"}
                        className="h-8 rounded-full px-3 flex-row items-center gap-2 text-muted-foreground hover:text-foreground font-normal text-xs"
                        onPress={handleSearchToggle}
                      >
                        <Globe size={16} className={searchMode ? "text-primary-foreground" : "text-muted-foreground"} />
                      </Button>

                      {thinkingMode && (
                        <View className="h-8 rounded-full px-3 flex-row items-center gap-1.5" style={{ backgroundColor: '#a855f720' }}>
                          <Brain size={14} color="#a855f7" />
                          <Text className="text-xs font-medium" style={{ color: '#a855f7' }}>Thinking</Text>
                          <Pressable onPress={handleThinkingMode} className="active:opacity-70">
                            <X size={12} color="#a855f7" />
                          </Pressable>
                        </View>
                      )}

                      {ghostMode && (
                        <View className="h-8 rounded-full px-3 flex-row items-center gap-1.5" style={{ backgroundColor: '#00b2ff20' }}>
                          <Ghost size={14} color="#00b2ff" />
                          <Text className="text-xs font-medium" style={{ color: '#00b2ff' }}>Ghost</Text>
                          <Pressable onPress={handleGhostMode} className="active:opacity-70">
                            <X size={12} color="#00b2ff" />
                          </Pressable>
                        </View>
                      )}

                      {agentMode && (
                        <View className="h-8 rounded-full px-3 flex-row items-center gap-1.5" style={{ backgroundColor: '#f9731620' }}>
                          <Bot size={14} color="#f97316" />
                          <Text className="text-xs font-medium" style={{ color: '#f97316' }}>Agent</Text>
                          <Pressable onPress={handleAgentMode} className="active:opacity-70">
                            <X size={12} color="#f97316" />
                          </Pressable>
                        </View>
                      )}

                      {deepResearchMode && (
                        <View className="h-8 rounded-full px-3 flex-row items-center gap-1.5" style={{ backgroundColor: '#10b98120' }}>
                          <Search size={14} color="#10b981" />
                          <Text className="text-xs font-medium" style={{ color: '#10b981' }}>Deep research</Text>
                          <Pressable onPress={handleDeepResearch} className="active:opacity-70">
                            <X size={12} color="#10b981" />
                          </Pressable>
                        </View>
                      )}

                      {shoppingResearchMode && (
                        <View className="h-8 rounded-full px-3 flex-row items-center gap-1.5" style={{ backgroundColor: '#ec489920' }}>
                          <ShoppingBag size={14} color="#ec4899" />
                          <Text className="text-xs font-medium" style={{ color: '#ec4899' }}>Shopping</Text>
                          <Pressable onPress={handleShoppingResearch} className="active:opacity-70">
                            <X size={12} color="#ec4899" />
                          </Pressable>
                        </View>
                      )}

                      {studyMode && (
                        <View className="h-8 rounded-full px-3 flex-row items-center gap-1.5" style={{ backgroundColor: '#6366f120' }}>
                          <BookOpen size={14} color="#6366f1" />
                          <Text className="text-xs font-medium" style={{ color: '#6366f1' }}>Study</Text>
                          <Pressable onPress={handleStudyAndLearn} className="active:opacity-70">
                            <X size={12} color="#6366f1" />
                          </Pressable>
                        </View>
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
                                value={deepResearchMode ? 'on' : 'off'}
                                onValueChange={handleDeepResearch}
                              >
                                <DropdownMenu.ItemIcon ios={{ name: "magnifyingglass" }} />
                                <DropdownMenu.ItemTitle>Deep research</DropdownMenu.ItemTitle>
                              </DropdownMenu.CheckboxItem>
                              <DropdownMenu.CheckboxItem
                                key="shopping"
                                value={shoppingResearchMode ? 'on' : 'off'}
                                onValueChange={handleShoppingResearch}
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
                            value={ghostMode ? 'on' : 'off'}
                            onValueChange={handleGhostMode}
                          >
                            <DropdownMenu.ItemIcon ios={{ name: "eye.slash" }} />
                            <DropdownMenu.ItemTitle>Ghost mode</DropdownMenu.ItemTitle>
                          </DropdownMenu.CheckboxItem>
                          <DropdownMenu.CheckboxItem
                            key="agent"
                            value={agentMode ? 'on' : 'off'}
                            onValueChange={handleAgentMode}
                          >
                            <DropdownMenu.ItemIcon ios={{ name: "cpu" }} />
                            <DropdownMenu.ItemTitle>Agent mode</DropdownMenu.ItemTitle>
                          </DropdownMenu.CheckboxItem>
                          {isNarrowScreen ? (
                            <>
                              <DropdownMenu.Separator />
                              <DropdownMenu.Item key="sources" onSelect={handleAddSources}>
                                <DropdownMenu.ItemIcon ios={{ name: "link" }} />
                                <DropdownMenu.ItemTitle>Add sources</DropdownMenu.ItemTitle>
                              </DropdownMenu.Item>
                              <DropdownMenu.CheckboxItem
                                key="study"
                                value={studyMode ? 'on' : 'off'}
                                onValueChange={handleStudyAndLearn}
                              >
                                <DropdownMenu.ItemIcon ios={{ name: "book" }} />
                                <DropdownMenu.ItemTitle>Study and learn</DropdownMenu.ItemTitle>
                              </DropdownMenu.CheckboxItem>
                              <DropdownMenu.CheckboxItem
                                key="search"
                                value={searchMode ? 'on' : 'off'}
                                onValueChange={handleWebSearch}
                              >
                                <DropdownMenu.ItemIcon ios={{ name: "globe" }} />
                                <DropdownMenu.ItemTitle>Web search</DropdownMenu.ItemTitle>
                              </DropdownMenu.CheckboxItem>
                              <DropdownMenu.Item key="canvas" onSelect={handleCanvas}>
                                <DropdownMenu.ItemIcon ios={{ name: "pencil.tip" }} />
                                <DropdownMenu.ItemTitle>Canvas</DropdownMenu.ItemTitle>
                              </DropdownMenu.Item>
                            </>
                          ) : (
                            <DropdownMenu.Sub>
                              <DropdownMenu.SubTrigger key="more">
                                <DropdownMenu.ItemIcon ios={{ name: "ellipsis" }} />
                                <DropdownMenu.ItemTitle>More</DropdownMenu.ItemTitle>
                              </DropdownMenu.SubTrigger>
                              <DropdownMenu.SubContent>
                                <DropdownMenu.Item key="sources" onSelect={handleAddSources}>
                                  <DropdownMenu.ItemIcon ios={{ name: "link" }} />
                                  <DropdownMenu.ItemTitle>Add sources</DropdownMenu.ItemTitle>
                                </DropdownMenu.Item>
                                <DropdownMenu.CheckboxItem
                                  key="study"
                                  value={studyMode ? 'on' : 'off'}
                                  onValueChange={handleStudyAndLearn}
                                >
                                  <DropdownMenu.ItemIcon ios={{ name: "book" }} />
                                  <DropdownMenu.ItemTitle>Study and learn</DropdownMenu.ItemTitle>
                                </DropdownMenu.CheckboxItem>
                                <DropdownMenu.CheckboxItem
                                  key="search"
                                  value={searchMode ? 'on' : 'off'}
                                  onValueChange={handleWebSearch}
                                >
                                  <DropdownMenu.ItemIcon ios={{ name: "globe" }} />
                                  <DropdownMenu.ItemTitle>Web search</DropdownMenu.ItemTitle>
                                </DropdownMenu.CheckboxItem>
                                <DropdownMenu.Item key="canvas" onSelect={handleCanvas}>
                                  <DropdownMenu.ItemIcon ios={{ name: "pencil.tip" }} />
                                  <DropdownMenu.ItemTitle>Canvas</DropdownMenu.ItemTitle>
                                </DropdownMenu.Item>
                              </DropdownMenu.SubContent>
                            </DropdownMenu.Sub>
                          )}
                        </DropdownMenu.Content>
                      </DropdownMenu.Root>
                    </View>

                    <View className="flex-row items-center gap-1.5">
                      <Pressable
                        onPress={handleMicPress}
                        disabled={stt.isTranscribing}
                        className="h-8 w-8 rounded-full items-center justify-center active:opacity-70"
                      >
                        {stt.isTranscribing ? (
                          <ActivityIndicator size="small" color="#6366f1" />
                        ) : stt.isRecording ? (
                          <MicOff size={16} color="#ef4444" />
                        ) : (
                          <Mic size={16} className="text-muted-foreground" />
                        )}
                      </Pressable>
                      <SubmitButtonWrapper
                        isLoading={isLoading}
                        stop={onStop}
                        inputValue={inputValue}
                        attachments={attachments}
                        onVoicePress={() => setShowVoice(true)}
                      />
                    </View>
                  </PromptInputActions>
                </PromptInput>
              </View>
            </View>
          </View>
        </LinearGradient>
      </View>

      <VoiceChat visible={showVoice} onClose={() => setShowVoice(false)} />
      <CanvasPanel visible={showCanvas} onClose={() => setShowCanvas(false)} components={canvasComponents} />
    </View>
  );
};
