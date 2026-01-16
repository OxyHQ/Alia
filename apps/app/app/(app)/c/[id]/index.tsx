import { generateUUID } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import { View, Alert, Platform, Pressable } from "react-native";
import { useStreamingChat } from "@/hooks/useStreamingChat";
import { ChatInterface } from "@/components/chat-interface";
import { ChatHeader } from "@/components/chat-header";
import { PromptInput, PromptInputTextarea, PromptInputActions, usePromptInput } from "@/components/ui/prompt-input";
import { Button } from "@/components/ui/button";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { useStore } from "@/lib/globalStore";
import { Plus, Globe, ArrowUp, Square, Search, ShoppingBag, ImageIcon, Sparkles, MoreHorizontal, BookOpen, ExternalLink, PenTool, X, FileText, Ghost, Check } from "lucide-react-native";
import { generateAPIUrl } from "@/lib/generate-api-url";
import { useImagePicker } from "@/hooks/useImagePicker";
import * as DocumentPicker from 'expo-document-picker';
import { AttachmentPreview } from "@/components/attachment-preview";
import { Dropdown, MenuItem, SubMenu } from "@/components/ui/dropdown";
import { Text } from "@/components/ui/text";
import { useLocalSearchParams } from "expo-router";
import { useRolesStore } from "@/lib/stores/roles-store";
import { useAuthStore } from "@/lib/stores/auth-store";

// Submit button wrapper that uses context
const SubmitButtonWrapper = ({
  isLoading,
  stop,
  inputValue,
  attachments
}: {
  isLoading: boolean;
  stop: () => void;
  inputValue: string;
  attachments: any[]
}) => {
  const { onSubmit } = usePromptInput();

  return (
    <Button
      size="icon"
      onPress={isLoading ? stop : onSubmit}
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

const ChatConversationPage = () => {
  const { id, initialMessage, roleId } = useLocalSearchParams<{ id: string; initialMessage?: string; roleId?: string }>();
  const roles = useRolesStore((state) => state.roles);
  const [activeRoleId, setActiveRoleId] = useState<string | undefined>(roleId);
  const activeRole = activeRoleId ? roles.find(r => r.id === activeRoleId) : undefined;

  // Use selectors to avoid worklet serialization issues
  const chatId = useStore((state) => state.chatId);
  const selectedImageUris = useStore((state) => state.selectedImageUris);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const [selectedModel, setSelectedModel] = useState("alia-v1");
  const [searchMode, setSearchMode] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [ghostMode, setGhostMode] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [initialMessageSent, setInitialMessageSent] = useState(false);
  const [loadingImageUris, setLoadingImageUris] = useState<Set<string>>(new Set());
  const { pickImage } = useImagePicker();

  // Load conversations on mount
  useEffect(() => {
    useStore.getState().loadConversations();
  }, []);

  // Set chatId from URL parameter
  useEffect(() => {
    if (id && (!chatId || chatId.id !== id)) {
      useStore.getState().setChatId({ id, from: "url" });
    }
  }, [id, chatId]);

  // Generate the API URL using the official Expo method
  const apiUrl = generateAPIUrl('/alia/chat');

  const {
    messages,
    error,
    append,
    isLoading,
    setMessages,
    stop,
    conversationTitle,
  } = useStreamingChat(apiUrl, activeRole);

  const handleSubmit = () => {
    if (!inputValue.trim() || isLoading) return;

    useStore.getState().setBottomChatHeightHandler(true);
    append({
      role: 'user',
      content: inputValue,
    });
    setInputValue("");
    useStore.getState().clearImageUris();
  };

  const handleSuggestionPress = (message: string) => {
    if (isLoading) return;

    useStore.getState().setBottomChatHeightHandler(true);
    append({
      role: 'user',
      content: message,
    });
  };

  const handleAddPhotos = async () => {
    if (!isAuthenticated) {
      Alert.alert('Sign in required', 'Please sign in to upload images.');
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
      Alert.alert('Sign in required', 'Please sign in to upload documents.');
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
          // Add document URI - we'll detect the type in the preview component
          useStore.getState().addImageUri(asset.uri);
        });
      }
    } catch (err) {
      console.error('Error picking documents:', err);
      Alert.alert('Error', 'Failed to pick documents. Please try again.');
    }
  };

  const handleRemoveAttachment = (uri: string) => {
    useStore.getState().removeImageUri(uri);
  };

  const handleImagePaste = async (files: File[]) => {
    if (!isAuthenticated) {
      Alert.alert('Sign in required', 'Please sign in to paste images.');
      return;
    }

    try {
      // Convert File objects to URIs and add to store
      for (const file of files) {
        // Generate a temporary ID for this file
        const tempId = `loading-${Date.now()}-${Math.random()}`;

        // Add to loading set
        setLoadingImageUris(prev => new Set(prev).add(tempId));

        // Add temporary placeholder to store
        useStore.getState().addImageUri(tempId);

        // Create a local URI from the File object
        const reader = new FileReader();
        reader.onload = (e) => {
          const dataUrl = e.target?.result as string;
          if (dataUrl) {
            // Remove the placeholder
            useStore.getState().removeImageUri(tempId);
            // Add the actual data URL
            useStore.getState().addImageUri(dataUrl);
            // Remove from loading set
            setLoadingImageUris(prev => {
              const newSet = new Set(prev);
              newSet.delete(tempId);
              return newSet;
            });
          }
        };
        reader.onerror = (e) => {
          console.error('FileReader error:', e);
          // Remove from loading set and store on error
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
      Alert.alert('Error', 'Failed to process pasted images. Please try again.');
    }
  };

  // Convert URIs to attachment format with type detection
  const attachments = selectedImageUris.map((uri) => {
    // Check if this URI is still loading
    const isLoading = loadingImageUris.has(uri);

    // Detect if it's an image based on data URL prefix or file extension
    const isDataUrlImage = uri.startsWith('data:image/');
    const isFileImage = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(uri);
    const isImage = isDataUrlImage || isFileImage || isLoading; // Treat loading items as images
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
    Alert.alert('Search mode', newValue ? 'Enabled - Web search will be used' : 'Disabled');
  };

  const handleDeepResearch = () => {
    Alert.alert('Deep research', 'Deep research mode activated! This will perform comprehensive analysis.');
  };

  const handleShoppingResearch = () => {
    Alert.alert('Shopping research', 'Shopping research mode activated! I will help you find and compare products.');
  };

  const handleAgentMode = () => {
    const newValue = !agentMode;
    setAgentMode(newValue);
    Alert.alert('Agent mode', newValue ? 'Enabled - I can now perform actions autonomously' : 'Disabled');
  };

  const handleGhostMode = () => {
    const newValue = !ghostMode;
    setGhostMode(newValue);
    Alert.alert('Ghost mode', newValue ? 'Enabled - Conversations will not be saved' : 'Disabled - Conversations will be saved normally');
  };

  const handleAddSources = () => {
    Alert.alert('Add sources', 'You can add URLs, documents, or other sources for me to reference.');
  };

  const handleStudyAndLearn = () => {
    Alert.alert('Study and learn', 'Study mode will help you learn and understand topics deeply.');
  };

  const handleWebSearch = () => {
    Alert.alert('Web search', 'Web search will be performed for your query.');
  };

  const handleCanvas = () => {
    Alert.alert('Canvas', 'Canvas mode for collaborative editing coming soon!');
  };

  const handleEditMessage = (messageId: string, newContent: string) => {
    const updatedMessages = messages.map(msg =>
      msg.id === messageId ? { ...msg, content: newContent } : msg
    );
    setMessages(updatedMessages);
  };

  const scrollViewRef = useRef<GHScrollView>(null) as React.RefObject<GHScrollView>;

  // Load conversation messages when chatId is set from URL
  useEffect(() => {
    if (id) {
      const loadedMessages = useStore.getState().loadConversationMessages(id);
      if (loadedMessages.length > 0) {
        setMessages(loadedMessages);
      }
    }
  }, [id, setMessages]);

  // Send initial message if provided and not already sent
  useEffect(() => {
    if (initialMessage && !initialMessageSent && !isLoading && append) {
      setInitialMessageSent(true);
      useStore.getState().setBottomChatHeightHandler(true);
      append({
        role: 'user',
        content: initialMessage,
      });
    }
  }, [initialMessage, initialMessageSent, isLoading, append]);

  // Auto-save conversation after messages change (only if ghost mode is disabled)
  useEffect(() => {
    if (id && messages.length > 0 && !isLoading && !ghostMode) {
      const timeoutId = setTimeout(() => {
        useStore.getState().saveConversation(id, messages, conversationTitle || undefined);
      }, 2000);

      return () => clearTimeout(timeoutId);
    }
  }, [id, messages, isLoading, conversationTitle, ghostMode]);

  return (
    <View className="flex-1 bg-background">
      <ChatHeader
        title="Alia"
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        onGhostModePress={handleGhostMode}
        ghostModeActive={ghostMode}
      />

      <View className="flex-1">
        <View className="flex-1 flex-col justify-between">
          <ChatInterface
            messages={messages}
            scrollViewRef={scrollViewRef}
            isLoading={isLoading}
            onSuggestionPress={handleSuggestionPress}
            onEditMessage={handleEditMessage}
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
                  {/* Attachment Preview */}
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

                      {ghostMode && (
                        <View className="h-8 rounded-full px-3 flex-row items-center gap-1.5" style={{ backgroundColor: '#00b2ff20' }}>
                          <Ghost size={14} color="#00b2ff" />
                          <Text className="text-xs font-medium" style={{ color: '#00b2ff' }}>Ghost</Text>
                          <Pressable onPress={handleGhostMode} className="active:opacity-70">
                            <X size={12} color="#00b2ff" />
                          </Pressable>
                        </View>
                      )}

                      {/* Role Chip */}
                      {activeRole && (
                        <View className="h-8 rounded-full px-3 bg-primary/10 flex-row items-center gap-1.5">
                          <Sparkles size={12} className="text-primary" />
                          <Text className="text-xs font-medium text-primary" numberOfLines={1}>
                            {activeRole.name}
                          </Text>
                          <Pressable onPress={() => setActiveRoleId(undefined)} className="active:opacity-70">
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
                      stop={stop}
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

export default ChatConversationPage;
