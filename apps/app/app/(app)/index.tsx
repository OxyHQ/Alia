import { useState, useEffect } from "react";
import { useLocalSearchParams } from "expo-router";
import Head from "expo-router/head";
import { useRolesStore } from "@/lib/stores/roles-store";
import { useStore } from "@/lib/globalStore";
import { useModelStore } from "@/lib/stores/model-store";
import { useChatConversation } from "@/hooks/useChatConversation";
import { ChatPageContent } from "@/components/chat-page-content";

const ChatPage = () => {
  const { roleId, skillId: skillIdParam } = useLocalSearchParams<{ roleId?: string; skillId?: string }>();
  const roles = useRolesStore((state) => state.roles);
  const activeSkillId = useStore((state) => state.activeSkillId);

  const effectiveSkillId = skillIdParam || activeSkillId;

  useEffect(() => {
    if (skillIdParam && skillIdParam !== activeSkillId) {
      useStore.getState().setActiveSkillId(skillIdParam);
    }
  }, [skillIdParam, activeSkillId]);

  const selectedModel = useModelStore((s) => s.selectedModel);
  const setSelectedModel = useModelStore((s) => s.setSelectedModel);
  const [activeRoleId, setActiveRoleId] = useState<string | undefined>(roleId);
  const activeRole = activeRoleId ? roles.find(r => r.id === activeRoleId) : undefined;

  const {
    messages,
    isLoading,
    scrollViewRef,
    createNewConversation,
    editMessage,
    clearConversation,
  } = useChatConversation({ activeRole, selectedModel, skillId: effectiveSkillId });

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
