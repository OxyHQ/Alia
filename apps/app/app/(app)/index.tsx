import { useState } from "react";
import Head from "expo-router/head";
import { useLocalSearchParams } from "expo-router";
import { useRolesStore } from "@/lib/stores/roles-store";
import { useChatConversation } from "@/hooks/useChatConversation";
import { ChatPageContent } from "@/components/chat-page-content";

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
      <Head>
        <title>Alia</title>
        <meta name="description" content="Start a conversation with Alia. Get answers, explore ideas, and boost your productivity." />
        <link rel="canonical" href="https://alia.onl/" />
      </Head>
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
