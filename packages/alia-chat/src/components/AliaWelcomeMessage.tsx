import { Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import { AliaAvatar } from './AliaAvatar';

export interface AliaWelcomeMessageProps {
  /** The greeting, e.g. "Hi Nate, what's on your mind?". */
  greeting: string;
  subtitle?: string;
  markSize?: number;
}

/**
 * The empty chat's greeting: the avatar beside it at display size, centred. The Alia app and
 * the SDK chat draw exactly this. Always side by side: a chat is a sheet or a column, whose
 * width is not the window's, so a viewport breakpoint would stack it in a sheet on a desktop.
 * The greeting has a max width (`max-w-xs`, 20rem) so it sets in two lines at any width, as a
 * headline beside a mark rather than one long line across a wide column.
 * The suggestions are not part of it; they sit over the composer (`ComposerSuggestions`).
 */
export function AliaWelcomeMessage({ greeting, subtitle, markSize = 38 }: AliaWelcomeMessageProps) {
  return (
    <View className="items-center gap-2">
      <View className="flex-row items-center justify-center gap-3">
        <AliaAvatar size={markSize} interactive />
        <Text
          selectable={false}
          className="max-w-xs shrink text-left text-4xl tracking-tight text-text-primary"
        >
          {greeting}
        </Text>
      </View>
      {subtitle ? (
        <Text className="text-center text-lg text-text-secondary">{subtitle}</Text>
      ) : null}
    </View>
  );
}
