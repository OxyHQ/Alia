import React from 'react';
import { View } from 'react-native';
import { IdentityMark } from '@alia.onl/sdk';
import { Text } from '@/components/ui/text';
import { agentTint } from '@/lib/agents/agent-color';
import { useColorScheme } from '@/lib/useColorScheme';

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
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {agent.name}
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-row items-center gap-1">
      {/* Spaced, not overlapped. The avatar-stack idiom leans on each face being
          an opaque disc that hides the edge of the one behind it; a mark is the
          bare flower, so a negative margin just tangles two of them into a shape
          that is neither. The ring those discs needed goes with it. */}
      {visible.map((agent) => (
        <IdentityMark
          key={agent._id}
          size={size}
          color={agentTint(agent.color, colors)}
          accessibilityLabel={agent.name}
        />
      ))}
      {/* The counter is a chip rather than a face, so it keeps its own disc. */}
      {overflow > 0 && (
        <View
          style={{ width: size, height: size }}
          className="rounded-full bg-muted items-center justify-center"
        >
          <Text className="text-[10px] font-medium text-muted-foreground">
            +{overflow}
          </Text>
        </View>
      )}
      <Text className="text-xs text-muted-foreground ml-2">
        {agents.length} agents
      </Text>
    </View>
  );
});
