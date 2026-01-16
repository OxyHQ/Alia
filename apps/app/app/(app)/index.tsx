import { generateUUID } from "@/lib/utils";
import { useRef, useEffect, useState } from "react";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { useStore } from "@/lib/globalStore";
import { useRouter } from "expo-router";
import { ChatPageContent } from "@/components/chat-page-content";

const ChatPage = () => {
  const router = useRouter();
  const [selectedModel, setSelectedModel] = useState("alia-v1");
  const scrollViewRef = useRef<GHScrollView>(null) as React.RefObject<GHScrollView>;

  // Clear any existing chatId when landing on the main page
  useEffect(() => {
    useStore.getState().setChatId(null);
  }, []);

  const handleSubmit = (inputValue: string) => {
    if (!inputValue.trim()) return;

    // Store the initial message in the global store
    useStore.getState().setPendingInitialMessage(inputValue);

    // Generate new chat ID
    const newChatId = generateUUID();

    // Navigate to the new chat
    router.push(`/(app)/c/${newChatId}` as any);
  };

  const handleSuggestionPress = (message: string) => {
    if (!message.trim()) return;

    // Store the initial message in the global store
    useStore.getState().setPendingInitialMessage(message);

    // Generate new chat ID
    const newChatId = generateUUID();

    // Navigate to the new chat
    router.push(`/(app)/c/${newChatId}` as any);
  };

  return (
    <ChatPageContent
      messages={[]}
      scrollViewRef={scrollViewRef}
      isLoading={false}
      onSubmit={handleSubmit}
      onSuggestionPress={handleSuggestionPress}
      onEditMessage={() => {}}
      selectedModel={selectedModel}
      onModelChange={setSelectedModel}
    />
  );
};

export default ChatPage;
