import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { useChatConversation } from "@/hooks/useChatConversation";
import { ChatPageContent } from "@/components/chat-page-content";
import { UsageLimitDialog } from "@/components/usage-limit-dialog";
import { UsageLimitError } from "@/lib/errors/usage-limit-error";
import { isThinkingModel } from "@/components/model-selector";

const ChatConversationPage = () => {
  const { id } = useLocalSearchParams<{ id: string }>();

  const [selectedModel, setSelectedModel] = useState("clarity-v1");
  const thinkingMode = isThinkingModel(selectedModel);

  const {
    messages,
    isLoading,
    conversationLoading,
    error,
    scrollViewRef,
    sendMessage,
    editMessage,
    stopGeneration,
    clearConversation,
    clearError,
    approvePlan,
    rejectPlan,
  } = useChatConversation({ conversationId: id, thinkingMode, selectedModel });

  // Check both instanceof AND name — Hermes can break instanceof for Error subclasses
  const usageLimitError = (error instanceof UsageLimitError || (error as any)?.name === 'UsageLimitError')
    ? (error as UsageLimitError)
    : null;

  return (
    <>
      <ChatPageContent
        messages={messages}
        scrollViewRef={scrollViewRef}
        isLoading={isLoading}
        conversationLoading={conversationLoading}
        onSubmit={sendMessage}
        onSuggestionPress={sendMessage}
        onEditMessage={editMessage}
        onStop={stopGeneration}
        onClear={clearConversation}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        disabled={!!usageLimitError}
        onApprovePlan={approvePlan}
        onRejectPlan={rejectPlan}
      />
      <UsageLimitDialog error={usageLimitError} onDismiss={clearError} />
    </>
  );
};

export default ChatConversationPage;
