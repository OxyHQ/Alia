import { agentTint } from '@/shared/domain/agent-color';
import { agentDisplayName, agentHandle } from '@/features/agents/model/identity';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { Agent } from '@/shared/contracts/agents';
import { useColorScheme } from '@/shared/platform/useColorScheme';
import { IdentityMark } from '@alia.onl/sdk';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card, CardBody, CardTitle } from '@oxy.so/bloom/card';
import { RiFlashlightLine } from '@oxy.so/bloom/icons/RiFlashlightLine';
import { Muted, Text } from '@oxy.so/bloom/typography';
import React from 'react';
import { View } from 'react-native';

interface AgentCardProps {
  agent: Agent;
  onPress: (id: string) => void;
  onChat?: (id: string) => void;
  onHire?: (id: string) => void;
  variant?: 'featured' | 'grid';
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** The agent's status, as the tone of Bloom's status dot. */
const STATUS_TONE = {
  active: 'success',
  idle: 'warning',
  offline: 'default',
} as const satisfies Record<Agent['status'], string>;

/**
 * One agent in the catalogue: a Bloom `Card` holding the agent's mark, name,
 * handle, tagline and numbers, with Chat and — for a public agent — Start task.
 */
export const AgentCard = React.memo(function AgentCard({
  agent,
  onPress,
  onChat,
  onHire,
  variant = 'grid',
}: AgentCardProps) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const isFeatured = variant === 'featured';
  const handle = agentHandle(agent);
  const stats = [
    `${formatCount(agent.hireCount)} ${t('agents.hires')}`,
    `${formatCount(agent.usageCount)} ${t('agents.uses')}`,
    ...(agent.rating > 0 ? [`${agent.rating} ${t('agents.rating')}`] : []),
  ].join(' · ');

  return (
    <Card
      appearance="outline"
      onPress={() => onPress(agent._id)}
      // It opens the agent's page, so it is a link — and not a `<button>`
      // on web, which could not hold the card's own buttons.
      accessibilityRole="link"
      accessibilityLabel={agentDisplayName(agent)}
      className={isFeatured ? 'w-[300px]' : 'flex-1'}
    >
      {/* Two bodies with a spring between them: the grid equalises a row's
          heights, and the spring keeps every card's numbers and task action
          on the same bottom line. */}
      <CardBody>
        <View className="gap-2 pt-2">
          {/* The mark, carrying the status dot, and Chat beside it. */}
          <View className="flex-row items-start justify-between">
            <Badge
              dot
              color={STATUS_TONE[agent.status]}
              placement="bottom-right"
            >
              <IdentityMark
                size={isFeatured ? 64 : 56}
                color={agentTint(agent.color, colors)}
                accessibilityLabel={agentDisplayName(agent)}
              />
            </Badge>
            <Button
              size="sm"
              tone="neutral"
              stopPropagation
              onPress={() => onChat?.(agent._id)}
            >
              {t('agents.chat')}
            </Button>
          </View>

          <View>
            <CardTitle numberOfLines={1}>{agentDisplayName(agent)}</CardTitle>
            {/* Handle — absent when Oxy could not resolve the bot account. */}
            {handle !== '' && <Muted numberOfLines={1}>@{handle}</Muted>}
          </View>

          <Text variant="body-regular" numberOfLines={2}>
            {agent.tagline}
          </Text>
        </View>
      </CardBody>

      {/* Pushes the numbers and the task action to the bottom of the card. */}
      <View className="flex-1" />

      <CardBody>
        <View className="gap-2 pb-2">
          <Muted>{stats}</Muted>

          {/* Only an agent anyone may use offers the button to everyone; a
            private one is reached through its own thread, by people who were
            given access. */}
          {agent.access === 'public' && (
            <Button
              size="sm"
              tone="neutral"
              appearance="outline"
              leadingIcon={RiFlashlightLine}
              stopPropagation
              onPress={() => onHire?.(agent._id)}
            >
              {agent.price != null
                ? t('agents.startTaskPriced', { count: agent.price })
                : t('agents.startTask')}
            </Button>
          )}
        </View>
      </CardBody>
    </Card>
  );
});
