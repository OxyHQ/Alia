import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { ConversationApprovalsBanner } from '@/features/agents/ui/agent-approvals-banner';
import { ConversationScreen } from '@/features/chat/ui/conversation-screen';

const ChatConversationPage = () => {
  const { id, agentId, startVoice } = useLocalSearchParams<{
    id: string;
    agentId?: string;
    startVoice?: string;
  }>();

  // A payment or a deletion Alia (or an agent) asked for in this conversation
  // waits here for the person's OK, as an agent's requests do above its thread.
  return (
    <View className="flex-1 web:z-auto">
      <ConversationApprovalsBanner conversationId={id} />
      <ConversationScreen
        conversationId={id}
        agentId={agentId}
        startVoice={startVoice === 'true'}
      />
    </View>
  );
};

export default ChatConversationPage;
