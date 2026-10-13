import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { RiCloseLine, RiDeleteBin6Line } from '@oxy.so/bloom/icons';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useLabels } from '../lib/labels';
import { AliaChatMark } from './AliaChatContent';

export interface AliaChatHeaderProps {
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
function AliaProfile({ onPress }: { onPress?: () => void }) {
  const { colors } = useTheme();
  const [hovered, setHovered] = useState(false);
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
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className="items-center"
    >
      <View pointerEvents="none" style={{ marginBottom: -2, zIndex: 1 }}>
        <AliaChatMark size={56} reactionKey={reactionKey} />
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
export function AliaChatHeader({
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
      title={<AliaProfile onPress={onProfilePress} />}
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
