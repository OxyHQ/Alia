import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { RiCloseLine, RiDeleteBin6Line } from '@oxy.so/bloom/icons';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { AgentProfile } from '@oxy.so/bloom/agent-reply';
import { type ReactNode, useMemo } from 'react';
import { agentCharacter } from '../lib/agent-character';
import { useLabels } from '../lib/labels';
import { ALIA_AVATAR } from './AliaAvatar';
import type { AliaChatAgent } from './AliaChatContent';

export interface AliaChatHeaderProps {
  /** The chat has messages to clear. */
  hasMessages: boolean;
  /** Delegated agents that have answered: they join Alia in the profile, up to three in all. */
  agents?: AliaChatAgent[];
  onClear: () => void;
  /** Draws the close island; omit where the chat is not dismissible. */
  onClose?: () => void;
  /** After the avatar, before the title — a host's back button. */
  leading?: ReactNode;
  /** The host's own actions, kept before clear and close. */
  trailing?: ReactNode;
  /** Pressing Alia's avatar or name. Omitted, the avatar waves. */
  onProfilePress?: () => void;
}

/**
 * Alia's profile, Bloom's `AgentProfile`: her avatar above a name capsule, joined by the agents
 * that answered ("Alia + Lumi + Atlas"). Pressing it makes every avatar wave.
 */
function AliaProfile({ agents, onPress }: { agents: AliaChatAgent[]; onPress?: () => void }) {
  const team = useMemo(
    () => [
      { id: 'alia', name: 'Alia', avatar: ALIA_AVATAR },
      ...agents.map((agent) => ({ ...agent, avatar: agentCharacter(agent.id) })),
    ],
    [agents],
  );
  return <AgentProfile agents={team} onPress={onPress ?? noop} />;
}

const noop = () => undefined;

/**
 * The chat's top bar: Bloom's `PageHeader`, set up as the shell sets it up for the
 * agents' screens (inline, no scrim, no safe area). Alia's profile is its title only once
 * there is a conversation: the empty chat already shows the avatar beside its greeting,
 * so the bar carries just its buttons until then.
 */
export function AliaChatHeader({
  hasMessages,
  agents = [],
  onClear,
  onClose,
  leading,
  trailing,
  onProfilePress,
}: AliaChatHeaderProps) {
  const labels = useLabels();
  return (
    <PageHeader
      leading={leading}
      title={hasMessages ? <AliaProfile agents={agents} onPress={onProfilePress} /> : undefined}
      titleAlign="center"
      actions={
        <>
          {trailing}
          <ButtonGroup accessibilityLabel={labels.chatActions}>
            {hasMessages ? (
              <ButtonGroupItem
                iconOnly
                leadingIcon={RiDeleteBin6Line}
                accessibilityLabel={labels.clear}
                onPress={onClear}
              />
            ) : null}
            {onClose ? (
              <ButtonGroupItem
                iconOnly
                leadingIcon={RiCloseLine}
                accessibilityLabel={labels.close}
                onPress={onClose}
              />
            ) : null}
          </ButtonGroup>
        </>
      }
      scrim="none"
      sticky={false}
      safeArea={false}
    />
  );
}
