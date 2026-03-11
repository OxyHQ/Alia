import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';

interface AgentInfo {
  _id: string;
  name: string;
  avatar?: string;
}

interface AgentAvatarRowProps {
  agents: AgentInfo[];
  size?: number;
}

const MAX_VISIBLE = 3;

export const AgentAvatarRow = React.memo(function AgentAvatarRow({
  agents,
  size = 28,
}: AgentAvatarRowProps) {
  if (agents.length === 0) return null;

  const visible = agents.slice(0, MAX_VISIBLE);
  const overflow = agents.length - MAX_VISIBLE;
  const sizeClass = 'h-7 w-7';

  if (agents.length === 1) {
    const agent = agents[0];
    return (
      <View className="flex-row items-center gap-2">
        <Avatar className={sizeClass}>
          {agent.avatar ? (
            <AvatarImage source={agent.avatar} />
          ) : (
            <AvatarFallback className="bg-muted">
              <Text className="text-[10px] font-medium text-muted-foreground">
                {agent.name?.charAt(0) || '?'}
              </Text>
            </AvatarFallback>
          )}
        </Avatar>
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
          <Avatar className={sizeClass}>
            {agent.avatar ? (
              <AvatarImage source={agent.avatar} />
            ) : (
              <AvatarFallback className="bg-muted">
                <Text className="text-[10px] font-medium text-muted-foreground">
                  {agent.name?.charAt(0) || '?'}
                </Text>
              </AvatarFallback>
            )}
          </Avatar>
        </View>
      ))}
      {overflow > 0 && (
        <View
          style={{ marginLeft: -8 }}
          className="border-2 border-background rounded-full"
        >
          <View
            className={`${sizeClass} rounded-full bg-muted items-center justify-center`}
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
