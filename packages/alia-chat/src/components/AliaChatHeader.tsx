import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { RiCloseLine, RiDeleteBin6Line } from '@oxy.so/bloom/icons';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Text } from '@oxy.so/bloom/typography';
import { memo, type ReactNode, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useLabels } from '../lib/labels';
import { AliaAvatar, type AliaAvatarState } from './AliaAvatar';

export interface AliaChatHeaderProps {
  /** What Alia is doing; the avatar shows it. */
  markState: AliaAvatarState;
  /** The chat has messages to clear. */
  hasMessages: boolean;
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
function AliaProfile({ markState, onPress }: { markState: AliaAvatarState; onPress?: () => void }) {
  const [reactionKey, setReactionKey] = useState(0);

  // Without a host action the profile is still a button: the avatar waves back.
  const handlePress = () => {
    if (onPress) onPress();
    else setReactionKey((key) => key + 1);
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Alia"
      onPress={handlePress}
      className="group/profile items-center"
    >
      <View pointerEvents="none" className="z-10 -mb-0.5">
        <AliaAvatar size={56} state={markState} reactionKey={reactionKey} />
      </View>
      <View
        pointerEvents="none"
        className="items-center justify-center rounded-[14px] border border-border-secondary bg-background-secondary-default px-2.5 py-1 group-hover/profile:bg-background-tertiary-default"
      >
        <Text numberOfLines={1} className="text-[16px] font-medium leading-5 text-text-primary">
          Alia
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * The chat's top bar: Bloom's `PageHeader`, set up as the shell sets it up for the
 * agents' screens (inline, no scrim, no safe area), with Alia's profile as its title.
 */
export const AliaChatHeader = memo(function AliaChatHeader({
  markState,
  hasMessages,
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
      title={<AliaProfile markState={markState} onPress={onProfilePress} />}
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
});
