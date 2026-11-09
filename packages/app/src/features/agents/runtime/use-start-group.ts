import { useCreateConversation } from '@alia.onl/sdk/runtime';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';

/**
 * Start a group conversation with these agents (two to six, in the order they will answer) and go
 * to it. The conversation is made by `POST /conversations/new` with `agentIds`; the chat screen
 * reads its members back from the conversation, so nothing else has to travel with the route.
 */
export function useStartGroup() {
  const router = useRouter();
  const create = useCreateConversation();
  const start = useCallback(
    async (agentIds: readonly string[]): Promise<void> => {
      const conversation = await create.mutateAsync({ agentIds });
      router.push(`/(app)/c/${conversation.id}`);
    },
    [create, router],
  );
  return { start, starting: create.isPending };
}
