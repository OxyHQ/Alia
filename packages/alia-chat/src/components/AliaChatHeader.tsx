import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { RiCloseLine, RiDeleteBin6Line } from '@oxy.so/bloom/icons';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useLabels } from '../lib/labels';
import { AgentAvatar } from '@oxy.so/bloom/agent-avatar';
import { agentCharacter } from '../lib/agent-character';
import { AliaChatMark, type AliaChatAgent } from './AliaChatContent';

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
 * Alia's avatar above a name capsule, the conversation header of Bloom's `MultiAgentChat`.
 *
 * TODO(bloom): `ChatAgentProfile` draws exactly this (a 56px avatar over a 28px capsule
 * of radius 14, `backgroundSecondary` with a hairline border) but is not exported, so
 * this repeats its geometry. Use Bloom's component when it is.
 */
function AliaProfile({ agents, onPress }: { agents: AliaChatAgent[]; onPress?: () => void }) {
  const { colors } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [reactionKey, setReactionKey] = useState(0);
  const alone = agents.length === 0;
  // "Alia + Lumi + Atlas": the first three, as the multi-agent header names its team.
  const name = ['Alia', ...agents.map((agent) => agent.name)].slice(0, 3).join(' + ');

  // Without a host action the profile is still a button: the avatar waves back.
  const handlePress = () => {
    if (onPress) onPress();
    else setReactionKey((key) => key + 1);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      onPress={handlePress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className="items-center"
    >
      <View
        pointerEvents="none"
        style={{ width: 56, height: 56, marginBottom: -2, zIndex: 1 }}
        accessibilityElementsHidden
      >
        {alone ? (
          <AliaChatMark size={56} reactionKey={reactionKey} />
        ) : (
          // Alia and up to two agents overlap as in Bloom's multi-agent header: the first at the
          // top start, the second down and right, the third below.
          <>
            <View style={{ position: 'absolute', start: 0, top: 0 }}>
              <AliaChatMark size={36} reactionKey={reactionKey} />
            </View>
            {agents.slice(0, 2).map((agent, index) => (
              <View
                key={agent.id}
                style={{
                  position: 'absolute',
                  start: index === 0 ? 20 : 10,
                  top: index === 0 ? 0 : 20,
                }}
              >
                <AgentAvatar
                  character={agentCharacter(agent.id)}
                  size={36}
                  reactionKey={reactionKey}
                />
              </View>
            ))}
          </>
        )}
      </View>
      <View
        pointerEvents="none"
        className="items-center justify-center rounded-[14px] px-2.5 py-1"
        style={{
          backgroundColor: hovered ? colors.backgroundTertiary : colors.backgroundSecondary,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
        }}
      >
        <Text numberOfLines={1} className="text-[16px] font-medium leading-5 text-text-primary">
          {name}
        </Text>
      </View>
    </Pressable>
  );
}

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
