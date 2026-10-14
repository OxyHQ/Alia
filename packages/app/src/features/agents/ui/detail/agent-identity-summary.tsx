import { agentDisplayName, agentHandle } from '@/features/agents/model/identity';
import { useTranslation } from '@/shared/i18n/use-translation';
import type { Agent } from '@/shared/contracts/agents';
import { readAgentCharacter } from '@alia.onl/sdk';
import { AgentAvatar } from '@oxy.so/bloom/agent-avatar';
import { Badge } from '@oxy.so/bloom/badge';
import { Rating } from '@oxy.so/bloom/rating';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';

/** The agent's status, as the tone of Bloom's status dot and badge. */
const STATUS_TONE = {
  active: 'success',
  idle: 'warning',
  offline: 'default',
} as const;

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Who the agent is: the mark in its own colour carrying the status dot, the
 * name, handle and author, the tagline, and how it has been received.
 */
export function AgentIdentitySummary({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const handle = agentHandle(agent);

  return (
    <View className="gap-1.5">
      <View className="self-start">
        <Badge dot color={STATUS_TONE[agent.status]} placement="bottom-right">
          <AgentAvatar
            size={80}
            character={readAgentCharacter(agent.character)}
            label={agentDisplayName(agent)}
          />
        </Badge>
      </View>
      <View className="flex-row items-center gap-2">
        <Text variant="title-3-semibold">{agentDisplayName(agent)}</Text>
        <Badge
          size="label-small"
          variant="subtle"
          color={STATUS_TONE[agent.status]}
          content={t(
            `agents.status${agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}`,
          )}
        />
      </View>
      {/* Handle + Author — both read from Oxy, both absent when it could
          not resolve the account, so an unresolved agent shows no row of
          separators around nothing. */}
      {(handle !== '' || agent.authorName !== null) && (
        <Muted>
          {[handle !== '' ? `@${handle}` : null, agent.authorName]
            .filter((part) => part !== null)
            .join(' · ')}
        </Muted>
      )}
      {agent.tagline ? <Text variant="body-regular">{agent.tagline}</Text> : null}
      <View className="flex-row items-center gap-3">
        <Rating value={agent.rating} count={agent.reviewCount} size="sm" />
        <Muted>
          {formatCount(agent.hireCount)} {t('agents.hires')} · {formatCount(agent.usageCount)}{' '}
          {t('agents.uses')}
        </Muted>
      </View>
    </View>
  );
}
