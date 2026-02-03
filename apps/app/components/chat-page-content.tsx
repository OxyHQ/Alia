import { useState } from "react";
import { View, Pressable } from "react-native";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { useStore } from "@/lib/globalStore";
import { Plus, Globe, ArrowUp, ImageIcon, MoreHorizontal, X, FileText, Ghost, Check, Search, ShoppingBag, BookOpen, ExternalLink, PenTool, Sparkles, Square, Brain } from "lucide-react-native";
import { useImagePicker } from "@/hooks/useImagePicker";
import * as DocumentPicker from 'expo-document-picker';
import { AttachmentPreview } from "@/components/attachment-preview";
import { Dropdown, MenuItem, SubMenu } from "@/components/ui/dropdown";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { PromptInput, PromptInputTextarea, PromptInputActions, usePromptInput } from "@/components/ui/prompt-input";
import { ChatInterface } from "@/components/chat-interface";
import { ChatHeader } from "@/components/chat-header";
import { useAuth } from "@oxyhq/services";
import type { Message } from "@/types/chat";
import { toast } from "@/components/sonner";

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
  onThinkingModeChange?: (value: boolean) => void;
}

const SubmitButtonWrapper = ({
  isLoading,
  stop,
  inputValue,
  attachments
}: {
  isLoading: boolean;
  stop?: () => void;
  inputValue: string;
  attachments: any[]
}) => {
  const { onSubmit } = usePromptInput();

  return (
    <Button
      size="icon"
      onPress={isLoading && stop ? stop : onSubmit}
      disabled={(!inputValue.trim() && attachments.length === 0) && !isLoading}
      className="h-8 w-8 rounded-full"
    >
      {isLoading ? (
        <Square
          size={12}
          color="white"
          className="fill-current"
        />
      ) : (
        <ArrowUp
          size={16}
          color="white"
        />
      )}
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
  onThinkingModeChange,
}: ChatPageContentProps) => {
  const selectedImageUris = useStore((state) => state.selectedImageUris);
  const { isAuthenticated } = useAuth();
  const [searchMode, setSearchMode] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [ghostMode, setGhostMode] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [loadingImageUris, setLoadingImageUris] = useState<Set<string>>(new Set());
  const { pickImage } = useImagePicker();

  const handleSubmit = () => {
    if (!inputValue.trim() || isLoading) return;
    onSubmit(inputValue);
    setInputValue("");
    useStore.getState().clearImageUris();
  };

  const handleSuggestionPress = (message: string) => {
    if (isLoading) return;
    onSuggestionPress(message);
  };

  const handleAddPhotos = async () => {
    if (!isAuthenticated) {
      toast.error('Please sign in to upload images.');
      return;
    }

    try {
      const imageUris = await pickImage();
      if (imageUris && imageUris.length > 0) {
        imageUris.forEach((uri) => useStore.getState().addImageUri(uri));
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
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets.length > 0) {
        result.assets.forEach((asset) => {
          useStore.getState().addImageUri(asset.uri);
        });
      }
    } catch (err) {
      console.error('Error picking documents:', err);
      toast.error('Failed to pick documents. Please try again.');
    }
  };

  const handleRemoveAttachment = (uri: string) => {
    useStore.getState().removeImageUri(uri);
  };

  const handleImagePaste = async (files: File[]) => {
    if (!isAuthenticated) {
      toast.error('Please sign in to paste images.');
      return;
    }

    try {
      for (const file of files) {
        const tempId = `loading-${Date.now()}-${Math.random()}`;
        setLoadingImageUris(prev => new Set(prev).add(tempId));
        useStore.getState().addImageUri(tempId);

        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target?.result as string;
          if (dataUrl) {
            useStore.getState().removeImageUri(tempId);
            useStore.getState().addImageUri(dataUrl);
            setLoadingImageUris(prev => {
              const newSet = new Set(prev);
              newSet.delete(tempId);
              return newSet;
            });
          }
        };
        reader.onerror = (e) => {
          console.error('FileReader error:', e);
          setLoadingImageUris(prev => {
            const newSet = new Set(prev);
            newSet.delete(tempId);
            return newSet;
          });
          useStore.getState().removeImageUri(tempId);
        };
        reader.readAsDataURL(file);
      }
    } catch (err) {
      console.error('Error handling pasted images:', err);
      toast.error('Failed to process pasted images. Please try again.');
    }
  };

  const attachments = selectedImageUris.map((uri) => {
    const isLoading = loadingImageUris.has(uri);
    const isDataUrlImage = uri.startsWith('data:image/');
    const isFileImage = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(uri);
    const isImage = isDataUrlImage || isFileImage || isLoading;
    const fileName = uri.split('/').pop() || 'Unknown file';

    return {
      uri,
      type: (isImage ? 'image' : 'document') as const,
      name: !isImage ? fileName : undefined,
      isLoading,
    };
  });

  const handleSearchToggle = () => {
    const newValue = !searchMode;
    setSearchMode(newValue);
    toast.info(newValue ? 'Web search will be used' : 'Search mode disabled');
  };

  const handleDeepResearch = () => {
    toast.info('Deep research mode activated! This will perform comprehensive analysis.');
  };

  const handleShoppingResearch = () => {
    toast.info('Shopping research mode activated! I will help you find and compare products.');
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
    const newValue = !thinkingMode;
    onThinkingModeChange?.(newValue);
    toast.info(newValue ? 'AI will show its reasoning process' : 'Thinking mode disabled');
  };

  const handleAddSources = () => {
    toast.info('You can add URLs, documents, or other sources for me to reference.');
  };

  const handleStudyAndLearn = () => {
    toast.info('Study mode will help you learn and understand topics deeply.');
  };

  const handleWebSearch = () => {
    toast.info('Web search will be performed for your query.');
  };

  const handleCanvas = () => {
    toast.info('Canvas mode for collaborative editing coming soon!');
  };

  return (
    <View className="flex-1 bg-background">
      <ChatHeader
        title="Alia"
        selectedModel={selectedModel}
        onModelChange={onModelChange}
        onGhostModePress={handleGhostMode}
        ghostModeActive={ghostMode}
        onClear={onClear}
      />

      <View className="flex-1">
        <View className="flex-1 flex-col justify-between">
          <ChatInterface
            messages={messages}
            scrollViewRef={scrollViewRef}
            isLoading={isLoading}
            onSuggestionPress={handleSuggestionPress}
            onEditMessage={onEditMessage}
          />

          <View className="p-4 bg-background border-t border-border">
            <View className="mx-auto w-full max-w-3xl flex-row items-end gap-2">
              <Dropdown
                align="start"
                trigger={
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 rounded-full text-muted-foreground hover:text-foreground"
                  >
                    <Plus size={20} className="text-muted-foreground" />
                  </Button>
                }
              >
                <MenuItem onPress={handleAddPhotos}>
                  <ImageIcon size={14} className="text-muted-foreground" />
                  <Text className="text-sm">Add photos</Text>
                </MenuItem>
                <MenuItem onPress={handleAddDocument}>
                  <FileText size={14} className="text-muted-foreground" />
                  <Text className="text-sm">Add document</Text>
                </MenuItem>
              </Dropdown>
              <View className="flex-1">
                <PromptInput
                  value={inputValue}
                  onValueChange={setInputValue}
                  onSubmit={handleSubmit}
                  isLoading={isLoading}
                  disabled={isLoading}
                  onImagePaste={handleImagePaste}
                >
                  <AttachmentPreview
                    attachments={attachments}
                    onRemove={handleRemoveAttachment}
                  />

                  <PromptInputTextarea
                    value={inputValue}
                    onChangeText={setInputValue}
                    placeholder="Message Alia..."
                    className="min-h-[44px] text-base md:text-base py-3"
                  />
                  <PromptInputActions className="flex-row items-center justify-between gap-2 mt-2 mb-1">
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

                      <Dropdown
                        align="start"
                        trigger={
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                          >
                            <MoreHorizontal size={16} className="text-muted-foreground" />
                          </Button>
                        }
                      >
                        <MenuItem onPress={handleDeepResearch}>
                          <Search size={14} className="text-muted-foreground" />
                          <Text className="text-sm">Deep research</Text>
                        </MenuItem>
                        <MenuItem onPress={handleShoppingResearch}>
                          <ShoppingBag size={14} className="text-muted-foreground" />
                          <Text className="text-sm">Shopping research</Text>
                        </MenuItem>
                        <MenuItem onPress={handleThinkingMode}>
                          <Brain size={14} className="text-muted-foreground" />
                          <Text className="text-sm">Thinking mode</Text>
                          {thinkingMode && <Check size={14} className="text-primary ml-auto" />}
                        </MenuItem>
                        <MenuItem onPress={handleGhostMode}>
                          <Ghost size={14} className="text-muted-foreground" />
                          <Text className="text-sm">Ghost mode</Text>
                          {ghostMode && <Check size={14} className="text-primary ml-auto" />}
                        </MenuItem>
                        <MenuItem onPress={handleAgentMode}>
                          <Sparkles size={14} className="text-muted-foreground" />
                          <Text className="text-sm">Agent mode</Text>
                          {agentMode && <Check size={14} className="text-primary ml-auto" />}
                        </MenuItem>
                        <SubMenu
                          trigger={
                            <>
                              <MoreHorizontal size={14} className="text-muted-foreground" />
                              <Text className="text-sm">More</Text>
                            </>
                          }
                        >
                          <MenuItem onPress={handleAddSources}>
                            <ExternalLink size={14} className="text-muted-foreground" />
                            <Text className="text-sm">Add sources</Text>
                          </MenuItem>
                          <MenuItem onPress={handleStudyAndLearn}>
                            <BookOpen size={14} className="text-muted-foreground" />
                            <Text className="text-sm">Study and learn</Text>
                          </MenuItem>
                          <MenuItem onPress={handleWebSearch}>
                            <Globe size={14} className="text-muted-foreground" />
                            <Text className="text-sm">Web search</Text>
                          </MenuItem>
                          <MenuItem onPress={handleCanvas}>
                            <PenTool size={14} className="text-muted-foreground" />
                            <Text className="text-sm">Canvas</Text>
                          </MenuItem>
                        </SubMenu>
                      </Dropdown>
                    </View>

                    <SubmitButtonWrapper
                      isLoading={isLoading}
                      stop={onStop}
                      inputValue={inputValue}
                      attachments={attachments}
                    />
                  </PromptInputActions>
                </PromptInput>
              </View>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
};
