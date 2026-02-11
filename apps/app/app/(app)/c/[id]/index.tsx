import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { useRolesStore } from "@/lib/stores/roles-store";
import { useStore } from "@/lib/globalStore";
import { useChatConversation } from "@/hooks/useChatConversation";
import { ChatPageContent } from "@/components/chat-page-content";

const ChatConversationPage = () => {
  const { id, roleId } = useLocalSearchParams<{ id: string; roleId?: string }>();
  const roles = useRolesStore((state) => state.roles);
  const activeSkillId = useStore((state) => state.activeSkillId);

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
    clearConversation,
  } = useChatConversation({ conversationId: id, activeRole, thinkingMode, selectedModel, skillId: activeSkillId });

  return (
    <ChatPageContent
      messages={messages}
      scrollViewRef={scrollViewRef}
      isLoading={isLoading}
      onSubmit={sendMessage}
      onSuggestionPress={sendMessage}
      onEditMessage={editMessage}
      onStop={stopGeneration}
      onClear={clearConversation}
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
