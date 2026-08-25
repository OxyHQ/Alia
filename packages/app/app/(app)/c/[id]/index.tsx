import { useLocalSearchParams } from "expo-router";
import { ConversationScreen } from "@/components/conversation-screen";

const ChatConversationPage = () => {
  const { id, agentId, startVoice } = useLocalSearchParams<{ id: string; agentId?: string; startVoice?: string }>();

  return (
    <ConversationScreen
      conversationId={id}
      agentId={agentId}
      startVoice={startVoice === 'true'}
    />
  );
};

export default ChatConversationPage;
