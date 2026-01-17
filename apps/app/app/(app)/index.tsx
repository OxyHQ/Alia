import { useState } from "react";
import Head from "expo-router/head";
import { useChatConversation } from "@/hooks/useChatConversation";
import { ChatPageContent } from "@/components/chat-page-content";

const ChatPage = () => {
  const [selectedModel, setSelectedModel] = useState("alia-v1");
  const {
    messages,
    isLoading,
    scrollViewRef,
    createNewConversation,
    editMessage,
  } = useChatConversation();

  return (
    <>
      <Head>
        <title>Alia</title>
        <meta name="description" content="Start a conversation with Alia. Get answers, explore ideas, and boost your productivity." />
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
      />
    </>
  );
};

export default ChatPage;
