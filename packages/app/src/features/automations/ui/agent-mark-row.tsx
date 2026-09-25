import { agentTint } from '@/shared/domain/agent-color';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useColorScheme } from '@/shared/platform/useColorScheme';
import { IdentityMark } from '@alia.onl/sdk';
import { Badge } from '@oxy.so/bloom/badge';
import { Muted, Text } from '@oxy.so/bloom/typography';
import React from 'react';
import { View } from 'react-native';
/**
 * The agents that ran a task, drawn as their own marks.
 *
 * `color` is nullable because the identity lookup behind it fails open — an
 * account Oxy could not resolve arrives without one and `agentTint` falls back
 * to the theme, which is what the row used to do with a missing avatar.
 */
interface AgentInfo {
  _id: string;
  name: string;
  color?: string | null;
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
  const { colors } = useColorScheme();
  const { t } = useTranslation();

  if (agents.length === 0) return null;

  const visible = agents.slice(0, MAX_VISIBLE);
  const overflow = agents.length - MAX_VISIBLE;

  if (agents.length === 1) {
    const agent = agents[0];
    return (
      <View className="flex-row items-center gap-2">
        <IdentityMark
          size={size}
          color={agentTint(agent.color, colors)}
          accessibilityLabel={agent.name}
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
          bare flower, so a negative margin just tangles two of them into a shape
          that is neither. */}
      {visible.map((agent) => (
        <IdentityMark
          key={agent._id}
          size={size}
          color={agentTint(agent.color, colors)}
          accessibilityLabel={agent.name}
        />
      ))}
      {overflow > 0 && (
        <Badge size="large" variant="subtle" content={`+${overflow}`} />
      )}
      <Muted>{t('tasks.agentCount', { count: agents.length })}</Muted>
    </View>
  );
});
