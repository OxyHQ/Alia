import type { AiChatThreadHandle } from '@oxy.so/bloom/ai-chat';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Text } from '@oxy.so/bloom/typography';
import { useMemo, useRef } from 'react';
import { View } from 'react-native';
import { useLabels } from '../../lib/labels';
import { type AliaLead, type AliaParticipant, participantOf } from '../../lib/participants';
import type { AgentExchange } from '../../runtime/thread/agent-exchange';
import type { Message } from '../../runtime/types';
import { AliaParticipants } from '../AliaParticipants';
import { AliaThread } from './AliaThread';

export interface AgentExchangeViewProps {
  exchange: AgentExchange;
  /** The conversation's lead: the asker of every consultation that names none. */
  lead: AliaLead;
  onBack: () => void;
}

/**
 * The conversation two agents had with each other, read-only: what the asker put to the consulted
 * agent and what it answered, drawn by the ordinary thread. The asker speaks as itself (an
 * assistant reply under its own name and avatar, never as the person) and so does the answerer.
 * There is no composer here and nothing to act on: it replaces the chat while it is open.
 */
export function AgentExchangeView({ exchange, lead, onBack }: AgentExchangeViewProps) {
  const { t, back } = useLabels();
  const threadRef = useRef<AiChatThreadHandle | null>(null);

  const { messages, asker, members } = useMemo(() => {
    const first = exchange.pairs.find((pair) => pair.asker !== null)?.asker ?? null;
    const askerIdentity: AliaParticipant = first ? participantOf(first) : lead;
    const rows: Message[] = [];
    exchange.pairs.forEach((pair, index) => {
      const pairAsker = pair.asker ?? (lead.isAlia ? null : lead);
      if (pair.task !== null) {
        rows.push({
          id: `exchange-${index}-ask`,
          role: 'assistant',
          content: pair.task,
          ...(pairAsker
            ? {
                agentInfo: {
                  id: pairAsker.id,
                  name: pairAsker.name,
                  handle: pairAsker.handle,
                  color: pairAsker.color,
                  character: 'character' in pairAsker ? pairAsker.character : undefined,
                },
              }
            : {}),
        });
      }
      if (pair.answer !== '') {
        rows.push({
          id: `exchange-${index}-answer`,
          role: 'assistant',
          content: pair.answer,
          agentInfo: exchange.agent,
        });
      }
    });
    return {
      messages: rows,
      asker: askerIdentity,
      // Everyone here is already in the conversation: no "Chatted with" line between them.
      members: new Set([askerIdentity.id, exchange.agent.id, lead.id]),
    };
  }, [exchange, lead]);

  const participants = useMemo(
    () => ({
      lead: { ...asker, isAlia: asker.id === lead.id && lead.isAlia, starters: [] },
      joined: [participantOf(exchange.agent)],
    }),
    [asker, exchange.agent, lead],
  );

  return (
    <View className="absolute inset-0 z-20 bg-background" testID="agent-exchange">
      <PageHeader
        leading={
          <ButtonGroup accessibilityLabel={back}>
            <ButtonGroupItem
              iconOnly
              leadingIcon={RiArrowLeftLine}
              accessibilityLabel={back}
              onPress={onBack}
            />
          </ButtonGroup>
        }
        title={<AliaParticipants participants={participants} />}
        titleAlign="center"
        scrim="none"
        sticky={false}
        safeArea={false}
      />
      <Text className="px-4 pb-2 text-center text-xs text-muted-foreground">
        {t('chat.agentChatNotice')}
      </Text>
      <AliaThread
        messages={messages}
        isLoading={false}
        memberIds={members}
        threadRef={threadRef}
        readOnly
      />
    </View>
  );
}
