import { generateUUID } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import { View, Alert, Platform } from "react-native";
import { useStreamingChat } from "@/hooks/useStreamingChat";
import { ChatInterface } from "@/components/chat-interface";
import { ChatHeader } from "@/components/chat-header";
import { PromptInput, PromptInputTextarea, PromptInputActions } from "@/components/ui/prompt-input";
import { Button } from "@/components/ui/button";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { useStore } from "@/lib/globalStore";
import { Plus, Globe, ArrowUp, Square, Search, ShoppingBag, ImageIcon, Sparkles, MoreHorizontal, BookOpen, ExternalLink, PenTool } from "lucide-react-native";
import { generateAPIUrl } from "@/lib/generate-api-url";
import { useImagePicker } from "@/hooks/useImagePicker";
import * as DocumentPicker from 'expo-document-picker';
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
import { useRouter } from "expo-router";

const ChatPage = () => {
  // Use selectors to avoid worklet serialization issues
  const chatId = useStore((state) => state.chatId);
  const [selectedModel, setSelectedModel] = useState("alia-v1");
  const [searchMode, setSearchMode] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const { pickImage } = useImagePicker();
  const router = useRouter();

  // Load conversations on mount
  useEffect(() => {
    useStore.getState().loadConversations();
  }, []);

  // Initialize chatId if not set
  useEffect(() => {
    if (!chatId) {
      useStore.getState().setChatId({ id: generateUUID(), from: "newChat" });
    }
  }, [chatId]);

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
  } = useStreamingChat(apiUrl);

  const handleSubmit = () => {
    if (!inputValue.trim() || isLoading) return;

    // If this is a new chat, navigate to /c/:id first
    if (chatId?.from === "newChat" && chatId?.id) {
      const messageToSend = inputValue;
      setInputValue("");
      useStore.getState().clearImageUris();

      // Navigate to conversation page - it will handle sending the message
      router.push({
        pathname: `/c/${chatId.id}`,
        params: { initialMessage: messageToSend }
      });
      return;
    }

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

    // If this is a new chat, navigate to /c/:id first
    if (chatId?.from === "newChat" && chatId?.id) {
      router.push({
        pathname: `/c/${chatId.id}`,
        params: { initialMessage: message }
      });
      return;
    }

    useStore.getState().setBottomChatHeightHandler(true);
    append({
      role: 'user',
      content: message,
    });
  };

  const handleAddPhotos = () => {
    Alert.alert(
      'Add photos & files',
      'Choose an option',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Add photos',
          onPress: async () => {
            const imageUris = await pickImage();
            if (imageUris) {
              imageUris.forEach((uri) => useStore.getState().addImageUri(uri));
            }
          },
        },
        {
          text: 'Add files',
          onPress: async () => {
            try {
              const result = await DocumentPicker.getDocumentAsync({
                type: '*/*',
                copyToCacheDirectory: true,
              });
              if (!result.canceled) {
                console.log('File selected:', result);
                Alert.alert('File selected', result.assets[0].name);
              }
            } catch (err) {
              console.error('Error picking document:', err);
            }
          },
        },
      ]
    );
  };

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

  const scrollViewRef = useRef<GHScrollView>(null) as React.RefObject<GHScrollView>;

  // Load conversation messages when chatId changes from sidebar
  useEffect(() => {
    if (chatId && chatId.from === "sidebar") {
      const loadedMessages = useStore.getState().loadConversationMessages(chatId.id);
      if (loadedMessages.length > 0) {
        setMessages(loadedMessages);
      }
    }
  }, [chatId, setMessages]);

  // Auto-save conversation after messages change
  useEffect(() => {
    if (chatId && messages.length > 0 && !isLoading) {
      const timeoutId = setTimeout(() => {
        useStore.getState().saveConversation(chatId.id, messages);
      }, 2000); // Debounce to avoid saving too frequently

      return () => clearTimeout(timeoutId);
    }
  }, [chatId, messages, isLoading]);

  return (
    <View className="flex-1 bg-background">
      <ChatHeader
        title="Alia"
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        onHostModePress={() => console.log("Host mode pressed")}
        onSearchPress={() => console.log("Search pressed")}
        onMorePress={() => console.log("More options pressed")}
      />

      <View className="flex-1">
        <ChatInterface
          messages={messages}
          scrollViewRef={scrollViewRef}
          isLoading={isLoading}
          onSuggestionPress={handleSuggestionPress}
        />

        <View className="p-4 bg-background border-t border-border">
          <View className="mx-auto w-full max-w-3xl flex-row items-end gap-2">
            <Button
              variant="outline"
              size="icon"
              className="h-10 w-10 rounded-full text-muted-foreground hover:text-foreground"
              onPress={handleAddPhotos}
            >
              <Plus size={20} className="text-muted-foreground" />
            </Button>
            <View className="flex-1">
              <PromptInput
                value={inputValue}
                onValueChange={setInputValue}
                onSubmit={handleSubmit}
                isLoading={isLoading}
              >
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
                    disabled={!inputValue.trim() && !isLoading}
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
  );
};

export default ChatPage;
