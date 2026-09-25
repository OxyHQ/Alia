import { AiChatMessageLine } from '@oxy.so/bloom/ai-chat';
import { Text } from 'react-native';

/**
 * A turn's status line — "Worked for 5m 32s", "Reasoning" — in the template's
 * secondary tone, and the way into that turn's thought panel.
 *
 * The press target is a nested `Text`, so the line keeps Bloom's paragraph
 * (its reveal, its tone) and only the words become the control. It works for
 * any turn, not only the one in flight: the panel is opened on this message,
 * in the conversation it belongs to.
 */
export function TurnStatusLine({
  label,
  hint,
  onPress,
}: {
  label: string;
  /** What pressing it does, for assistive technology. */
  hint?: string;
  onPress?: () => void;
}) {
  return (
    <AiChatMessageLine tone="secondary" selectable={false}>
      {onPress === undefined ? (
        label
      ) : (
        <Text accessibilityRole="button" accessibilityHint={hint} onPress={onPress}>
          {label}
        </Text>
      )}
    </AiChatMessageLine>
  );
}
