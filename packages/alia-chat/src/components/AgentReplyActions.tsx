import {
  RiFileCopyLine,
  RiStopFill,
  RiThumbDownLine,
  RiThumbUpLine,
  RiVolumeUpLine,
} from '@oxy.so/bloom/icons';
import { useTheme } from '@oxy.so/bloom/theme';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useLabels } from '../lib/labels';

/**
 * The row under a reply: helpful, unhelpful, copy — 22px tiles with 12px icons, as the replies
 * of Bloom's `MultiAgentChat` carry them — and, where the host reads aloud, one more tile.
 *
 * TODO(bloom): that row is built inline in `MultiAgentChatBase` and not exported, so this
 * repeats its geometry. Use Bloom's component when it is.
 */
export function AgentReplyActions({
  onLike,
  onDislike,
  onCopy,
  onReadAloud,
  reading = false,
  readDisabled = false,
}: {
  onLike?: () => void;
  onDislike?: () => void;
  onCopy: () => void;
  /** Reads the reply aloud; omitted, there is no tile. */
  onReadAloud?: () => void;
  /** The reply is being read: the tile stops it. */
  reading?: boolean;
  readDisabled?: boolean;
}) {
  const labels = useLabels();
  const { colors } = useTheme();
  const [vote, setVote] = useState<'up' | 'down' | null>(null);

  const tile = (
    label: string,
    onPress: () => void,
    Icon: typeof RiThumbUpLine,
    selected?: boolean,
    disabled?: boolean,
  ) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      aria-pressed={selected}
      disabled={disabled}
      onPress={onPress}
      className="h-[22px] w-[22px] items-center justify-center rounded-md"
      style={{ backgroundColor: colors.backgroundTertiary }}
    >
      <Icon width={12} height={12} fill={selected ? colors.primary : colors.textTertiary} />
    </Pressable>
  );

  return (
    <View className="mt-1 flex-row items-center gap-1">
      {tile(
        labels.helpful,
        () => {
          setVote('up');
          onLike?.();
        },
        RiThumbUpLine,
        vote === 'up',
      )}
      {tile(
        labels.unhelpful,
        () => {
          setVote('down');
          onDislike?.();
        },
        RiThumbDownLine,
        vote === 'down',
      )}
      {tile(labels.copy, onCopy, RiFileCopyLine)}
      {onReadAloud
        ? tile(
            reading ? labels.stopReading : labels.readAloud,
            onReadAloud,
            reading ? RiStopFill : RiVolumeUpLine,
            reading,
            readDisabled,
          )
        : null}
    </View>
  );
}
