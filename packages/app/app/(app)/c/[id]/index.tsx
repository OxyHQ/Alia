import { useLocalSearchParams } from 'expo-router';
import { ConversationScreen } from '@/features/chat/ui/conversation-screen';

const ChatConversationPage = () => {
  const { id, agentId } = useLocalSearchParams<{ id: string; agentId?: string }>();

  return <ConversationScreen conversationId={id} agentId={agentId} />;
};

export default ChatConversationPage;
