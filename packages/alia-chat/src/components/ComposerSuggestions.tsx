import { Item } from '@oxy.so/bloom/item';
import { Text } from '@oxy.so/bloom/typography';
import { View } from 'react-native';
import type { Completion } from '../lib/suggestions';
import type { AliaSuggestion } from '../types';

/**
 * Suggestions over the composer, one line each, the typed part highlighted and the row the
 * keyboard is on marked. The Alia app and the SDK chat draw exactly this.
 */
export function ComposerSuggestions<T extends AliaSuggestion>({
  completions,
  selected,
  onPick,
}: {
  completions: readonly Completion<T>[];
  selected: number;
  onPick: (suggestion: T) => void;
}) {
  if (completions.length === 0) return null;
  return (
    <View accessibilityRole="list" className="w-full max-w-[768px] self-center">
      {completions.map(({ suggestion, matchStart, matchEnd }, index) => {
        const { text } = suggestion;
        return (
          <Item
            key={suggestion.id}
            density="compact"
            highlighted={index === selected}
            accessibilityRole="button"
            accessibilityLabel={text}
            onPress={() => onPick(suggestion)}
            title={
              <Text numberOfLines={1}>
                {text.slice(0, matchStart)}
                <Text className="font-medium text-primary">{text.slice(matchStart, matchEnd)}</Text>
                {text.slice(matchEnd)}
              </Text>
            }
          />
        );
      })}
    </View>
  );
}
