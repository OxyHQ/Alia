import { useEffect, useCallback, useRef } from "react";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/hooks/query-keys";
import { useStore, type Attachment } from "@/lib/globalStore";
import { useStreamingChat } from "@/hooks/useStreamingChat";
import { useConversation, useCreateConversation } from "@/lib/hooks/use-conversations";
import { generateAPIUrl } from "@/lib/generate-api-url";
import { buildMessageContent } from "@/lib/attachment-utils";
import type { Role } from "@/lib/stores/roles-store";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";

interface UseChatConversationOptions {
  conversationId?: string;
  activeRole?: Role;
  thinkingMode?: boolean;
  selectedModel?: string;
  skillId?: string | null;
  agentId?: string;
}

export function useChatConversation({ conversationId, activeRole, thinkingMode, selectedModel, skillId, agentId }: UseChatConversationOptions = {}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const scrollViewRef = useRef<GHScrollView>(null);
  const hasSentPendingMessage = useRef(false);
  const lastConversationId = useRef<string | null>(null);
  const wasLoadingRef = useRef(false);

  const pendingInitialMessage = useStore((state) => state.pendingInitialMessage);
  const { data: conversation, isLoading: conversationQueryLoading, isFetching: conversationFetching } = useConversation(conversationId || "");
  const createConversationMutation = useCreateConversation();

  const {
    messages,
    append,
    isLoading,
    error,
    clearError,
    setMessages,
    stop,
  } = useStreamingChat(generateAPIUrl('/v1/chat/completions'), activeRole, conversationId, thinkingMode, selectedModel, skillId, agentId);

  // Refresh sidebar when streaming finishes (backend auto-saves with AI-generated title)
  useEffect(() => {
    if (wasLoadingRef.current && !isLoading && conversationId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(conversationId) });
    }
    wasLoadingRef.current = isLoading;
  }, [isLoading, conversationId, queryClient]);

  // Sync chatId and load messages when conversation changes or when
  // seeded cache data upgrades to full data (messages go from empty to populated).
  useEffect(() => {
    useStore.getState().setChatId(conversationId ? { id: conversationId, from: "url" } : null);

    if (!conversationId || conversationQueryLoading) return;

    const incomingMessages = conversation?.messages || [];
    const isNewConversation = lastConversationId.current !== conversationId;
    const isDataUpgrade = !isNewConversation && incomingMessages.length > 0 && messages.length === 0;

    if (!isNewConversation && !isDataUpgrade) return;

    if (isNewConversation) {
      lastConversationId.current = conversationId;
      hasSentPendingMessage.current = false;
    }

    const validMessages = incomingMessages
      .filter(msg => msg?.role && msg?.content !== undefined)
      .map((msg, index) => ({
        ...msg,
        id: msg.id || `db-${conversationId}-${index}`,
      }));
    setMessages(validMessages);
  }, [conversationId, conversation, conversationQueryLoading, setMessages, messages.length]);

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
  const sendMessage = useCallback(async (content: string, attachments?: Attachment[]) => {
    if (!content.trim() || isLoading) return;

    useStore.getState().setBottomChatHeightHandler(true);

    const messageContent = attachments?.length
      ? await buildMessageContent(content, attachments)
      : content;

    append({
      role: 'user',
      content: messageContent,
    });
    useStore.getState().clearAttachments();
  }, [isLoading, append]);

  const createNewConversation = useCallback(async (initialMessage: string, attachments?: Attachment[]) => {
    if (!initialMessage.trim()) return;

    // If there are attachments, build multi-part content and store it as pending
    if (attachments?.length) {
      const messageContent = await buildMessageContent(initialMessage, attachments);
      useStore.getState().setPendingInitialMessage(messageContent);
      useStore.getState().clearAttachments();
    } else {
      useStore.getState().setPendingInitialMessage(initialMessage);
    }

    // Create conversation on backend and get the ID
    const newConversation = await createConversationMutation.mutateAsync({ agentId });

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

  // True while loading conversation messages (initial fetch or seeded→full upgrade)
  const conversationLoading = conversationQueryLoading ||
    (conversationFetching && (!conversation?.messages || conversation.messages.length === 0));

  return {
    // State
    conversationId,
    messages,
    isLoading,
    conversationLoading,
    error,
    scrollViewRef,

    // Actions
    sendMessage,
    createNewConversation,
    editMessage,
    stopGeneration,
    clearConversation,
    clearError,
    setMessages,
  };
}
