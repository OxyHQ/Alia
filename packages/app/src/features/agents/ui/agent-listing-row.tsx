import { agentDisplayName } from '@/features/agents/model/identity';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { Agent } from '@/shared/contracts/agents';
import { readAgentCharacter } from '@alia.onl/sdk';
import { AgentAvatar } from '@oxy.so/bloom/agent-avatar';
import { Button } from '@oxy.so/bloom/button';
import { Item } from '@oxy.so/bloom/item';
import { Text } from '@oxy.so/bloom/typography';
import React from 'react';

/**
 * One agent in the catalogue, as a row: its mark, its name with "by author" after it, its tagline
 * under that, and Chat at the end. The whole row opens the agent's page; Chat opens its thread.
 * Rows sit two to a line where there is room, so the catalogue reads as a list to scan, not a wall
 * of cards.
 */
export const AgentListingRow = React.memo(function AgentListingRow({
  agent,
  onPress,
  onChat,
}: {
  agent: Agent;
  onPress: (id: string) => void;
  onChat: (id: string) => void;
}) {
  const { t } = useTranslation();
  const name = agentDisplayName(agent);
  const author = agent.authorName?.trim();
  return (
    <Item
      role="listitem"
      accessibilityLabel={name}
      onPress={() => onPress(agent._id)}
      leading={<AgentAvatar size={32} character={readAgentCharacter(agent.character)} portrait />}
      title={
        <Text numberOfLines={1} className="text-sm font-medium text-text-primary">
          {name}
          {author ? (
            <Text className="text-sm font-normal text-text-secondary">
              {' '}
              {t('agents.byAuthor', { name: author })}
            </Text>
          ) : null}
        </Text>
      }
      subtitle={agent.tagline}
      subtitleNumberOfLines={1}
      trailing={
        <Button
          size="sm"
          tone="neutral"
          appearance="subtle"
          stopPropagation
          onPress={() => onChat(agent._id)}
        >
          {t('agents.chat')}
        </Button>
      }
    />
  );
});
