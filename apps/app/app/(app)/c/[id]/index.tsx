import { useEffect, useRef, useState } from "react";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { useStore } from "@/lib/globalStore";
import { useConversation, useSaveConversation } from "@/lib/hooks/use-conversations";
import { generateAPIUrl } from "@/lib/generate-api-url";
import { useLocalSearchParams } from "expo-router";
import { useRolesStore } from "@/lib/stores/roles-store";
import { useStreamingChat } from "@/hooks/useStreamingChat";
import { ChatPageContent } from "@/components/chat-page-content";

const ChatConversationPage = () => {
  const { id, roleId } = useLocalSearchParams<{ id: string; roleId?: string }>();
  const roles = useRolesStore((state) => state.roles);
  const [activeRoleId, setActiveRoleId] = useState<string | undefined>(roleId);
  const activeRole = activeRoleId ? roles.find(r => r.id === activeRoleId) : undefined;

  const chatId = useStore((state) => state.chatId);
  const pendingInitialMessage = useStore((state) => state.pendingInitialMessage);
  const { data: conversation, isLoading: conversationLoading } = useConversation(id);
  const saveConversationMutation = useSaveConversation();
  const [selectedModel, setSelectedModel] = useState("alia-v1");
  const [initialMessageSent, setInitialMessageSent] = useState(false);
  const scrollViewRef = useRef<GHScrollView>(null) as React.RefObject<GHScrollView>;

  // Set chatId from URL parameter
  useEffect(() => {
    if (id && (!chatId || chatId.id !== id)) {
      useStore.getState().setChatId({ id, from: "url" });
    }
  }, [id, chatId]);

  const apiUrl = generateAPIUrl('/alia/chat');

  const {
    messages,
    append,
    isLoading,
    setMessages,
    stop,
    conversationTitle,
  } = useStreamingChat(apiUrl, activeRole);

  const handleSubmit = (inputValue: string) => {
    if (!inputValue.trim() || isLoading) return;

    useStore.getState().setBottomChatHeightHandler(true);
    append({
      role: 'user',
      content: inputValue,
    });
  };

  const handleSuggestionPress = (message: string) => {
    if (isLoading) return;

    useStore.getState().setBottomChatHeightHandler(true);
    append({
      role: 'user',
      content: message,
    });
  };

  const handleEditMessage = (messageId: string, newContent: string) => {
    const updatedMessages = messages.map(msg =>
      msg.id === messageId ? { ...msg, content: newContent } : msg
    );
    setMessages(updatedMessages);
  };

  // Load conversation messages when ID changes
  useEffect(() => {
    if (conversationLoading) return;

    setInitialMessageSent(false);

    const loadedMessages = conversation?.messages || [];
    setMessages(loadedMessages);
  }, [id, conversation, conversationLoading]);

  // Send initial message if provided and not already sent
  useEffect(() => {
    if (pendingInitialMessage && !initialMessageSent && !isLoading && append) {
      setInitialMessageSent(true);
      useStore.getState().setBottomChatHeightHandler(true);
      append({
        role: 'user',
        content: pendingInitialMessage,
      });
      useStore.getState().clearPendingInitialMessage();
    }
  }, [pendingInitialMessage, initialMessageSent, isLoading, append]);

  // Auto-save conversation after messages change
  useEffect(() => {
    if (id && messages.length > 0 && !isLoading) {
      const timeoutId = setTimeout(() => {
        saveConversationMutation.mutate({
          id,
          messages,
          title: conversationTitle || undefined
        });
      }, 2000);

      return () => clearTimeout(timeoutId);
    }
  }, [id, messages, isLoading, conversationTitle]);

  return (
    <ChatPageContent
      messages={messages}
      scrollViewRef={scrollViewRef}
      isLoading={isLoading}
      onSubmit={handleSubmit}
      onSuggestionPress={handleSuggestionPress}
      onEditMessage={handleEditMessage}
      onStop={stop}
      selectedModel={selectedModel}
      onModelChange={setSelectedModel}
      activeRole={activeRole}
      onRemoveRole={() => setActiveRoleId(undefined)}
    />
  );
};

export default ChatConversationPage;
