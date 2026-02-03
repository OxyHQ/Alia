import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import Head from "expo-router/head";
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
    clearConversation,
  } = useChatConversation({ activeRole, selectedModel });

  return (
    <>
      <Head>
        <title>Alia \ Oxy</title>
        <meta name="description" content="Meet Alia, your intelligent AI assistant. Chat naturally, remember everything, and switch between the best AI models seamlessly." />
        <link rel="canonical" href="https://alia.onl/" />
        <meta property="og:title" content="Alia \ Oxy" />
        <meta property="og:description" content="Meet Alia, your intelligent AI assistant. Chat naturally, remember everything, and switch between the best AI models seamlessly." />
        <meta property="og:image" content="https://alia.onl/og-image-default.png" />
      </Head>
      <ChatPageContent
        messages={messages}
        scrollViewRef={scrollViewRef}
        isLoading={isLoading}
        onSubmit={createNewConversation}
        onSuggestionPress={createNewConversation}
        onEditMessage={editMessage}
        onClear={clearConversation}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        activeRole={activeRole}
        onRemoveRole={() => setActiveRoleId(undefined)}
      />
    </>
  );
};

export default ChatPage;
