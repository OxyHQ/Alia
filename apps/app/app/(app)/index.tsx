import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { useRolesStore } from "@/lib/stores/roles-store";
import { useChatConversation } from "@/hooks/useChatConversation";
import { ChatPageContent } from "@/components/chat-page-content";
import { SEOHead } from "@/components/seo/SEOHead";
import { StructuredData } from "@/components/seo/StructuredData";
import { META_PRESETS } from "@/lib/seo/meta-tags";
import { STRUCTURED_DATA_PRESETS } from "@/lib/seo/structured-data";

const ChatPage = () => {
  const { roleId } = useLocalSearchParams<{ roleId?: string }>();
  const roles = useRolesStore((state) => state.roles);

  const [selectedModel, setSelectedModel] = useState("alia-v1");
  const [activeRoleId, setActiveRoleId] = useState<string | undefined>(roleId);
  const activeRole = activeRoleId ? roles.find(r => r.id === activeRoleId) : undefined;

  const {
    messages,
    isLoading,
    scrollViewRef,
    createNewConversation,
    editMessage,
  } = useChatConversation({ activeRole });

  return (
    <>
      <SEOHead {...META_PRESETS.home}>
        <StructuredData data={STRUCTURED_DATA_PRESETS.homepage} />
      </SEOHead>
      <ChatPageContent
        messages={messages}
        scrollViewRef={scrollViewRef}
        isLoading={isLoading}
        onSubmit={createNewConversation}
        onSuggestionPress={createNewConversation}
        onEditMessage={editMessage}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        activeRole={activeRole}
        onRemoveRole={() => setActiveRoleId(undefined)}
      />
    </>
  );
};

export default ChatPage;
