import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { RiArrowLeftLine, RiDeleteBin6Line, RiMoreFill, RiShare2Line } from '@oxy.so/bloom/icons';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { AgentProfile } from '@oxy.so/bloom/agent-reply';
import { type ReactNode, useMemo } from 'react';
import { agentCharacter } from '../lib/agent-character';
import { useLabels } from '../lib/labels';
import { ALIA_AVATAR } from './AliaAvatar';
import type { AliaChatAgent } from './AliaChatContent';

export interface AliaChatHeaderProps {
  /** The chat has messages: there is something to share and to clear. */
  hasMessages: boolean;
  /** Delegated agents that have answered: they join Alia in the profile, up to three in all. */
  agents?: AliaChatAgent[];
  /** Clears the conversation, from the menu. */
  onClear: () => void;
  /** Draws the back button at the start of the bar; omit where there is nowhere to go back to. */
  onBack?: () => void;
  /** Draws the share button, once there is a conversation; omit where the host cannot share. */
  onShare?: () => void;
  /** More rows for the menu (`DropdownMenuItem`s), before Clear. */
  menu?: ReactNode;
  /** The host's own start content instead of the back button, e.g. a navigation drawer's menu. */
  leading?: ReactNode;
  /** The host's own actions, before share and the menu. */
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
  onBack,
  onShare,
  menu,
  leading,
  trailing,
  onProfilePress,
}: AliaChatHeaderProps) {
  const labels = useLabels();
  // Share and the menu act on a conversation. With none there is nothing for them to do, and a
  // bar of dimmed buttons over the empty chat is chrome with no job: no bar at all, unless the
  // host brought content of its own (a back button to somewhere, a drawer's menu).
  if (!hasMessages && !onBack && leading === undefined && trailing === undefined) return null;
  return (
    <PageHeader
      leading={
        leading ??
        (onBack ? (
          <ButtonGroup accessibilityLabel={labels.chatActions}>
            <ButtonGroupItem
              iconOnly
              leadingIcon={RiArrowLeftLine}
              accessibilityLabel={labels.back}
              onPress={onBack}
            />
          </ButtonGroup>
        ) : undefined)
      }
      title={hasMessages ? <AliaProfile agents={agents} onPress={onProfilePress} /> : undefined}
      titleAlign="center"
      actions={
        <>
          {trailing}
          {hasMessages ? (
            <ButtonGroup accessibilityLabel={labels.chatActions}>
              {onShare ? (
                <ButtonGroupItem
                  iconOnly
                  leadingIcon={RiShare2Line}
                  accessibilityLabel={labels.share}
                  onPress={onShare}
                />
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild label={labels.more}>
                  <ButtonGroupItem
                    iconOnly
                    leadingIcon={RiMoreFill}
                    accessibilityLabel={labels.more}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {menu}
                  <DropdownMenuItem
                    tone="danger"
                    leading={<RiDeleteBin6Line width={16} height={16} />}
                    onPress={onClear}
                  >
                    {labels.clear}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </ButtonGroup>
          ) : null}
        </>
      }
      scrim="none"
      sticky={false}
      safeArea={false}
    />
  );
}
