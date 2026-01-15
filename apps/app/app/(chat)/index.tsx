import { generateUUID } from "@/lib/utils";
import { useEffect } from "react";
import { useStore } from "@/lib/globalStore";
import { useRouter } from "expo-router";

const ChatPage = () => {
  const router = useRouter();

  // Load conversations on mount
  useEffect(() => {
    useStore.getState().loadConversations();
  }, []);

  // Auto-redirect to a new conversation
  useEffect(() => {
    const redirectToNewChat = async () => {
      const newId = generateUUID();

      // Create empty conversation first
      await useStore.getState().createEmptyConversation(newId);

      // Set chatId
      useStore.getState().setChatId({ id: newId, from: "newChat" });

      // Navigate to the conversation page
      router.replace(`/c/${newId}`);
    };

    redirectToNewChat();
  }, [router]);

  // Return null or a loading indicator since we're redirecting immediately
  return null;
};

export default ChatPage;
