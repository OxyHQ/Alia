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
  thinkingMode?: boolean;
  selectedModel?: string;
  skillId?: string | null;
}

export function useChatConversation({ conversationId, activeRole, thinkingMode, selectedModel, skillId }: UseChatConversationOptions = {}) {
  const router = useRouter();
  const scrollViewRef = useRef<GHScrollView>(null);
  const hasSentPendingMessage = useRef(false);
  const lastConversationId = useRef<string | null>(null);

  const pendingInitialMessage = useStore((state) => state.pendingInitialMessage);
  const { data: conversation, isLoading: conversationLoading } = useConversation(conversationId || "");
  const createConversationMutation = useCreateConversation();

  const {
    messages,
    append,
    isLoading,
    setMessages,
    stop,
  } = useStreamingChat(generateAPIUrl('/v1/chat/completions'), activeRole, conversationId, thinkingMode, selectedModel, skillId);

  // Sync chatId and load messages when conversation changes
  useEffect(() => {
    useStore.getState().setChatId(conversationId ? { id: conversationId, from: "url" } : null);

    if (!conversationId || conversationLoading) return;
    if (lastConversationId.current === conversationId) return;

    lastConversationId.current = conversationId;
    hasSentPendingMessage.current = false;

    const validMessages = (conversation?.messages || [])
      .filter(msg => msg?.role && msg?.content !== undefined)
      .map((msg, index) => ({
        ...msg,
        id: msg.id || `db-${conversationId}-${index}`,
      }));
    setMessages(validMessages);
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

  const clearConversation = useCallback(() => {
    setMessages([]);
  }, [setMessages]);

  return {
    // State
    conversationId,
    messages,
    isLoading,
    scrollViewRef,

    // Actions
    sendMessage,
    createNewConversation,
    editMessage,
    stopGeneration,
    clearConversation,
  };
}
