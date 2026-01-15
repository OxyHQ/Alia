import { generateUUID } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import { View, Alert, Platform, Pressable } from "react-native";
import { useStreamingChat } from "@/hooks/useStreamingChat";
import { ChatInterface } from "@/components/chat-interface";
import { ChatHeader } from "@/components/chat-header";
import { PromptInput, PromptInputTextarea, PromptInputActions } from "@/components/ui/prompt-input";
import { Button } from "@/components/ui/button";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { useStore } from "@/lib/globalStore";
import { Plus, Globe, ArrowUp, Square, Search, ShoppingBag, ImageIcon, Sparkles, MoreHorizontal, BookOpen, ExternalLink, PenTool, X, FileText } from "lucide-react-native";
import { generateAPIUrl } from "@/lib/generate-api-url";
import { useImagePicker } from "@/hooks/useImagePicker";
import * as DocumentPicker from 'expo-document-picker';
import { AttachmentPreview } from "@/components/attachment-preview";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { Text } from "@/components/ui/text";
import { useLocalSearchParams } from "expo-router";
import { useRolesStore } from "@/lib/stores/roles-store";

const ChatConversationPage = () => {
  const { id, initialMessage, roleId } = useLocalSearchParams<{ id: string; initialMessage?: string; roleId?: string }>();
  const roles = useRolesStore((state) => state.roles);
  const [activeRoleId, setActiveRoleId] = useState<string | undefined>(roleId);
  const activeRole = activeRoleId ? roles.find(r => r.id === activeRoleId) : undefined;

  // Use selectors to avoid worklet serialization issues
  const chatId = useStore((state) => state.chatId);
  const selectedImageUris = useStore((state) => state.selectedImageUris);
  const [selectedModel, setSelectedModel] = useState("alia-v1");
  const [searchMode, setSearchMode] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [initialMessageSent, setInitialMessageSent] = useState(false);
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
  const apiUrl = generateAPIUrl('/api/alia/chat');

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

  // Convert URIs to attachment format with type detection
  const attachments = selectedImageUris.map((uri) => {
    // Detect if it's an image based on extension
    const isImage = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(uri);
    const fileName = uri.split('/').pop() || 'Unknown file';

    return {
      uri,
      type: (isImage ? 'image' : 'document') as const,
      name: !isImage ? fileName : undefined,
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

  const handleCreateImage = () => {
    Alert.alert('Create image', 'Image generation coming soon! You will be able to create images from text descriptions.');
  };

  const handleAgentMode = () => {
    const newValue = !agentMode;
    setAgentMode(newValue);
    Alert.alert('Agent mode', newValue ? 'Enabled - I can now perform actions autonomously' : 'Disabled');
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

  // Auto-save conversation after messages change
  useEffect(() => {
    if (id && messages.length > 0 && !isLoading) {
      const timeoutId = setTimeout(() => {
        useStore.getState().saveConversation(id, messages, conversationTitle || undefined);
      }, 2000); // Debounce to avoid saving too frequently

      return () => clearTimeout(timeoutId);
    }
  }, [id, messages, isLoading, conversationTitle]);

  return (
    <View className="flex-1 bg-background">
      <ChatHeader
        title="Alia"
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
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
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 rounded-full text-muted-foreground hover:text-foreground"
                  >
                    <Plus size={20} className="text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  <DropdownMenuItem onPress={handleAddPhotos}>
                    <ImageIcon size={16} className="text-muted-foreground" />
                    <Text>Add photos</Text>
                  </DropdownMenuItem>
                  <DropdownMenuItem onPress={handleAddDocument}>
                    <FileText size={16} className="text-muted-foreground" />
                    <Text>Add document</Text>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <View className="flex-1">
                <PromptInput
                  value={inputValue}
                  onValueChange={setInputValue}
                  onSubmit={handleSubmit}
                  isLoading={isLoading}
                  disabled={isLoading}
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

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                          >
                            <MoreHorizontal size={16} className="text-muted-foreground" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-56">
                          <DropdownMenuItem onPress={handleDeepResearch}>
                            <Search size={16} className="text-muted-foreground" />
                            <Text>Deep research</Text>
                          </DropdownMenuItem>
                          <DropdownMenuItem onPress={handleShoppingResearch}>
                            <ShoppingBag size={16} className="text-muted-foreground" />
                            <Text>Shopping research</Text>
                          </DropdownMenuItem>
                          <DropdownMenuItem onPress={handleCreateImage}>
                            <ImageIcon size={16} className="text-muted-foreground" />
                            <Text>Create image</Text>
                          </DropdownMenuItem>
                          <DropdownMenuItem onPress={handleAgentMode}>
                            <Sparkles size={16} className="text-muted-foreground" />
                            <Text>Agent mode</Text>
                          </DropdownMenuItem>
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger className="rounded-lg px-2.5 gap-2">
                              <MoreHorizontal size={16} className="text-muted-foreground" />
                              <Text>More</Text>
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                              <DropdownMenuItem onPress={handleAddSources}>
                                <ExternalLink size={16} className="text-muted-foreground" />
                                <Text>Add sources</Text>
                              </DropdownMenuItem>
                              <DropdownMenuItem onPress={handleStudyAndLearn}>
                                <BookOpen size={16} className="text-muted-foreground" />
                                <Text>Study and learn</Text>
                              </DropdownMenuItem>
                              <DropdownMenuItem onPress={handleWebSearch}>
                                <Globe size={16} className="text-muted-foreground" />
                                <Text>Web search</Text>
                              </DropdownMenuItem>
                              <DropdownMenuItem onPress={handleCanvas}>
                                <PenTool size={16} className="text-muted-foreground" />
                                <Text>Canvas</Text>
                              </DropdownMenuItem>
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </View>

                    <Button
                      size="icon"
                      onPress={isLoading ? stop : handleSubmit}
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
