import { useTranslation } from '@/shared/i18n/use-translation';
import { readAgentCharacter } from '@alia.onl/sdk';
import { AgentAvatar } from '@oxy.so/bloom/agent-avatar';
import { Badge } from '@oxy.so/bloom/badge';
import { Muted, Text } from '@oxy.so/bloom/typography';
import React from 'react';
import { View } from 'react-native';
/**
 * The agents that ran a task, drawn as their own marks.
 *
 * `character` is the agent's stored look (JSON), parsed where it is drawn.
 */
interface AgentInfo {
  _id: string;
  name: string;
  character: unknown;
}

interface AgentMarkRowProps {
  agents: AgentInfo[];
  size?: number;
}

const MAX_VISIBLE = 3;

export const AgentMarkRow = React.memo(function AgentMarkRow({
  agents,
  size = 28,
}: AgentMarkRowProps) {
  const { t } = useTranslation();

  if (agents.length === 0) return null;

  const visible = agents.slice(0, MAX_VISIBLE);
  const overflow = agents.length - MAX_VISIBLE;

  if (agents.length === 1) {
    const agent = agents[0];
    return (
      <View className="flex-row items-center gap-2">
        <AgentAvatar
          size={size}
          character={readAgentCharacter(agent.character)}
          label={agent.name}
        />
        <Text variant="body-medium" numberOfLines={1}>
          {agent.name}
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-row items-center gap-2">
      {/* Spaced, not overlapped. The avatar-stack idiom leans on each face being
          an opaque disc that hides the edge of the one behind it; a mark is the
          bare shape, so a negative margin just tangles two of them into a shape
          that is neither. */}
      {visible.map((agent) => (
        <AgentAvatar
          key={agent._id}
          size={size}
          character={readAgentCharacter(agent.character)}
          label={agent.name}
        />
      ))}
      {overflow > 0 && <Badge size="lg" variant="subtle" content={`+${overflow}`} />}
      <Muted>{t('tasks.agentCount', { count: agents.length })}</Muted>
    </View>
  );
});
