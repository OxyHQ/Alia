import { useEffect, useCallback, useRef } from "react";
import { useRouter } from "expo-router";
import { useStore } from "@/lib/globalStore";
import { useStreamingChat } from "@/hooks/useStreamingChat";
import { useConversation, useCreateConversation } from "@/lib/hooks/use-conversations";
import { generateAPIUrl } from "@/lib/generate-api-url";
import type { Role } from "@/lib/stores/roles-store";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";

interface UseChatConversationOptions {
  conversationId?: string;
  activeRole?: Role;
}

/**
 * Custom hook that manages chat conversation state and actions.
 * Combines streaming chat, conversation loading/saving, and navigation.
 */
export function useChatConversation({ conversationId, activeRole }: UseChatConversationOptions = {}) {
  const router = useRouter();
  const scrollViewRef = useRef<GHScrollView>(null) as React.RefObject<GHScrollView>;
  const hasSentPendingMessage = useRef(false);
  const lastLoadedConversationId = useRef<string | null>(null);

  const pendingInitialMessage = useStore((state) => state.pendingInitialMessage);

  // Load conversation data from server
  const { data: conversation, isLoading: conversationLoading } = useConversation(conversationId || "");

  // Create conversation mutation
  const createConversationMutation = useCreateConversation();

  // Streaming chat hook
  const apiUrl = generateAPIUrl('/alia/chat');
  const {
    messages,
    append,
    isLoading,
    setMessages,
    stop,
    conversationTitle,
  } = useStreamingChat(apiUrl, activeRole, conversationId || undefined);

  // Sync chatId with URL parameter
  useEffect(() => {
    if (conversationId) {
      useStore.getState().setChatId({ id: conversationId, from: "url" });
    } else {
      useStore.getState().setChatId(null);
    }
  }, [conversationId]);

  // Load conversation messages when conversation data changes
  useEffect(() => {
    if (conversationLoading || !conversationId) return;

    // Only load messages if conversation ID changed
    if (lastLoadedConversationId.current === conversationId) return;

    lastLoadedConversationId.current = conversationId;
    hasSentPendingMessage.current = false;

    const loadedMessages = (conversation?.messages || []).filter(msg => msg && msg.role && msg.content !== undefined);
    setMessages(loadedMessages);
  }, [conversationId, conversation, conversationLoading, setMessages]);

  // Send pending initial message for new conversations
  useEffect(() => {
    if (!conversationId || !pendingInitialMessage || isLoading) return;
    if (hasSentPendingMessage.current) return;
    if (messages.length > 0) return; // Only send if no messages yet

    hasSentPendingMessage.current = true;
    useStore.getState().setBottomChatHeightHandler(true);
    append({
      role: 'user',
      content: pendingInitialMessage,
    });
    useStore.getState().clearPendingInitialMessage();
  }, [conversationId, pendingInitialMessage, isLoading, messages.length, append]);

  // Actions
  const sendMessage = useCallback((content: string) => {
    if (!content.trim() || isLoading) return;

    useStore.getState().setBottomChatHeightHandler(true);
    append({
      role: 'user',
      content,
    });
    useStore.getState().clearImageUris();
  }, [isLoading, append]);

  const createNewConversation = useCallback(async (initialMessage: string) => {
    if (!initialMessage.trim()) return;

    // Create conversation on backend and get the ID
    const newConversation = await createConversationMutation.mutateAsync();

    // Store the initial message in the global store
    useStore.getState().setPendingInitialMessage(initialMessage);

    // Navigate to the new conversation
    router.replace(`/(app)/c/${newConversation.id}` as any);
  }, [router, createConversationMutation]);

  const editMessage = useCallback((messageId: string, newContent: string) => {
    const updatedMessages = messages.map(msg =>
      msg.id === messageId ? { ...msg, content: newContent } : msg
    );
    setMessages(updatedMessages);
  }, [messages, setMessages]);

  const stopGeneration = useCallback(() => {
    stop();
  }, [stop]);

  return {
    // State
    conversationId,
    messages,
    isLoading,
    conversationTitle,
    scrollViewRef,

    // Actions
    sendMessage,
    createNewConversation,
    editMessage,
    stopGeneration,
  };
}
