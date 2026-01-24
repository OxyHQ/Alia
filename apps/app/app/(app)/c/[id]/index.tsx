import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { useRolesStore } from "@/lib/stores/roles-store";
import { useChatConversation } from "@/hooks/useChatConversation";
import { ChatPageContent } from "@/components/chat-page-content";

const ChatConversationPage = () => {
  const { id, roleId } = useLocalSearchParams<{ id: string; roleId?: string }>();
  const roles = useRolesStore((state) => state.roles);

  const [selectedModel, setSelectedModel] = useState("alia-v1");
  const [activeRoleId, setActiveRoleId] = useState<string | undefined>(roleId);
  const [thinkingMode, setThinkingMode] = useState(false);
  const activeRole = activeRoleId ? roles.find(r => r.id === activeRoleId) : undefined;

  const {
    messages,
    isLoading,
    scrollViewRef,
    sendMessage,
    editMessage,
    stopGeneration,
  } = useChatConversation({ conversationId: id, activeRole, thinkingMode, selectedModel });

  return (
    <ChatPageContent
      messages={messages}
      scrollViewRef={scrollViewRef}
      isLoading={isLoading}
      onSubmit={sendMessage}
      onSuggestionPress={sendMessage}
      onEditMessage={editMessage}
      onStop={stopGeneration}
      selectedModel={selectedModel}
      onModelChange={setSelectedModel}
      activeRole={activeRole}
      onRemoveRole={() => setActiveRoleId(undefined)}
      thinkingMode={thinkingMode}
      onThinkingModeChange={setThinkingMode}
    />
  );
};

export default ChatConversationPage;
