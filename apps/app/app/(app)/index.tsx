import { useModelStore } from "@/lib/stores/model-store";
import { useChatConversation } from "@/hooks/useChatConversation";
import { ChatPageContent } from "@/components/chat-page-content";
import Head from "expo-router/head";

const SearchPage = () => {
  const selectedModel = useModelStore((s) => s.selectedModel);
  const setSelectedModel = useModelStore((s) => s.setSelectedModel);

  const {
    messages,
    isLoading,
    scrollViewRef,
    createNewConversation,
    editMessage,
    clearConversation,
  } = useChatConversation({ selectedModel });

  return (
    <>
      <Head>
        <title>Clarity | AI Search by Oxy</title>
        <meta name="description" content="Clarity is an AI-powered search engine by Oxy. Get answers with source citations, deep research, and follow-up questions." />
        <link rel="canonical" href="https://clarity.oxy.so/" />
        <meta property="og:title" content="Clarity | AI Search by Oxy" />
        <meta property="og:description" content="Clarity is an AI-powered search engine by Oxy. Get answers with source citations, deep research, and follow-up questions." />
        <meta property="og:image" content="https://clarity.oxy.so/og-image-default.png" />
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
      />
    </>
  );
};

export default SearchPage;
