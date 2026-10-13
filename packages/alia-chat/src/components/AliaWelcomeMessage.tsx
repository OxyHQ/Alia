import { Item } from '@oxy.so/bloom/item';
import { Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import type { WelcomeSuggestion } from '../types';
import { AliaAvatar } from './AliaAvatar';

export type { WelcomeSuggestion };

export interface AliaWelcomeMessageProps {
  /** The greeting, e.g. "Hi Nate, what's on your mind?". */
  greeting: string;
  subtitle?: string;
  suggestions?: WelcomeSuggestion[];
  onSuggestionPress?: (text: string) => void;
  markSize?: number;
  /** Leave the avatar out, where the surrounding header already shows it. */
  hideMark?: boolean;
}

/**
 * The empty chat, as the Alia app has it: the avatar beside the greeting at display
 * size, centred (stacked on a phone, side by side from `md`), and the suggestions as
 * compact rows under it.
 */
export function AliaWelcomeMessage({
  greeting,
  subtitle,
  suggestions = [],
  onSuggestionPress,
  markSize = 38,
  hideMark = false,
}: AliaWelcomeMessageProps) {
  return (
    <View className="flex-1 items-center justify-center gap-6 px-4">
      <View className="items-center gap-2">
        <View className="flex-col items-center justify-center gap-3 md:flex-row">
          {hideMark ? null : <AliaAvatar size={markSize} interactive />}
          <Text
            selectable={false}
            className="text-center text-4xl tracking-tight text-text-primary md:text-left"
          >
            {greeting}
          </Text>
        </View>
        {subtitle ? (
          <Text className="text-center text-lg text-text-secondary">{subtitle}</Text>
        ) : null}
      </View>

      {suggestions.length > 0 ? (
        <Animated.View
          entering={FadeIn.duration(400)}
          accessibilityRole="list"
          className="w-full max-w-[768px]"
        >
          {suggestions.map((item) => (
            <Item
              key={item.id}
              density="compact"
              accessibilityRole="button"
              accessibilityLabel={item.title}
              onPress={() => onSuggestionPress?.(item.description)}
              title={<Text numberOfLines={1}>{item.title}</Text>}
              subtitle={item.description}
            />
          ))}
        </Animated.View>
      ) : null}
    </View>
  );
}
