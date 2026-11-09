import { useMyAgents } from '@/features/agents/runtime/use-my-agents';
import { activeAgentFor } from '@/features/agents/model/active-agent';
import { readAgentCharacter } from '@alia.onl/sdk';
import { useConversations } from '@alia.onl/sdk/runtime';
import { avatarBodyHex, resolveAvatarCharacter } from '@oxy.so/bloom/agent-avatar';
import { BloomSeedScope } from '@oxy.so/bloom/theme';
import { usePathname } from 'expo-router';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { View } from 'react-native';

/**
 * The app takes the colour of the agent you are with. On an agent's thread, or a chat that belongs
 * to one, the whole app — sidebar, header, panel and dialogs — is Bloom's theme seeded from that
 * agent's own colour (the body of its character). Everywhere else the scope is a no-op and the app
 * keeps its preset, because `BloomSeedScope` with no seed inherits its parent.
 *
 * It sits inside the conversation runtime, which is where the conversation list the chat's agent
 * is looked up in comes from.
 */
export function AgentThemeScope({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data: agents } = useMyAgents();
  const { data } = useConversations();
  const conversations = useMemo(
    () => data?.pages.flatMap((page) => page.conversations) ?? [],
    [data],
  );
  const seed = useMemo(() => {
    const agent = activeAgentFor({ pathname, agents: agents ?? [], conversations });
    return agent
      ? avatarBodyHex(resolveAvatarCharacter(readAgentCharacter(agent.character)))
      : undefined;
  }, [pathname, agents, conversations]);

  return (
    <BloomSeedScope seed={seed} asChild>
      <View className="flex-1 web:z-auto">{children}</View>
    </BloomSeedScope>
  );
}
