import { groupMembersOf } from '@/features/agents/model/group-members';
import { useMyAgents } from '@/features/agents/runtime/use-my-agents';
import { ConversationScreen } from '@/features/chat/ui/conversation-screen';
import { useConversation } from '@alia.onl/sdk/runtime';
import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

const ChatConversationPage = () => {
  const { id, agentId } = useLocalSearchParams<{ id: string; agentId?: string }>();
  // A group conversation has no lead: its members, read from the conversation and the person's
  // own agents, are what the chat draws. The chat waits for them (its skeleton) rather than
  // greeting as Alia for a moment.
  const { data: conversation } = useConversation(id);
  const { data: agents } = useMyAgents();
  const memberIds = conversation?.memberAgentIds;
  const group = useMemo(() => groupMembersOf(memberIds, agents), [memberIds, agents]);
  const waitingForMembers = memberIds !== undefined && memberIds.length > 0 && group === undefined;

  return (
    <ConversationScreen
      conversationId={id}
      agentId={agentId}
      group={group}
      loading={waitingForMembers && agents === undefined}
    />
  );
};

export default ChatConversationPage;
