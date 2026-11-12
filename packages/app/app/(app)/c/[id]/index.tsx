import { ConversationScreen } from '@/features/chat/ui/conversation-screen';
import { useLocalSearchParams } from 'expo-router';

const ChatConversationPage = () => {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ConversationScreen conversationId={id} />;
};

export default ChatConversationPage;
