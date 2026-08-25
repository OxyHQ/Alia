import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { AgentGlyph } from '@/components/ui/agent-glyph';

/**
 * The agents that ran a task, drawn as their own marks.
 *
 * `color` is nullable because the identity lookup behind it fails open — an
 * account Oxy could not resolve arrives without one and the glyph falls back to
 * the theme, which is what the row used to do with a missing avatar.
 */
interface AgentInfo {
  _id: string;
  name: string;
  color?: string | null;
}

interface AgentGlyphRowProps {
  agents: AgentInfo[];
  size?: number;
}

const MAX_VISIBLE = 3;

export const AgentGlyphRow = React.memo(function AgentGlyphRow({
  agents,
  size = 28,
}: AgentGlyphRowProps) {
  if (agents.length === 0) return null;

  const visible = agents.slice(0, MAX_VISIBLE);
  const overflow = agents.length - MAX_VISIBLE;

  if (agents.length === 1) {
    const agent = agents[0];
    return (
      <View className="flex-row items-center gap-2">
        <AgentGlyph size={size} color={agent.color} label={agent.name} />
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {agent.name}
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-row items-center">
      {visible.map((agent, i) => (
        <View
          key={agent._id}
          style={i > 0 ? { marginLeft: -8 } : undefined}
          className="border-2 border-background rounded-full"
        >
          <AgentGlyph size={size} color={agent.color} label={agent.name} />
        </View>
      ))}
      {overflow > 0 && (
        <View
          style={{ marginLeft: -8 }}
          className="border-2 border-background rounded-full"
        >
          <View
            style={{ width: size, height: size }}
            className="rounded-full bg-muted items-center justify-center"
          >
            <Text className="text-[10px] font-medium text-muted-foreground">
              +{overflow}
            </Text>
          </View>
        </View>
      )}
      <Text className="text-xs text-muted-foreground ml-2">
        {agents.length} agents
      </Text>
    </View>
  );
});
