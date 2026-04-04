import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/text';
import Animated, { FadeIn } from 'react-native-reanimated';
import { ClarityLogo } from './ClarityLogo';
import { ArrowRight } from 'lucide-react-native';
import type { WelcomeSuggestion } from './types';

export type { WelcomeSuggestion };

export type SearchCategory = 'all' | 'academic' | 'news' | 'code' | 'social';

export interface ClarityWelcomeMessageProps {
  greeting: string;
  subtitle?: string;
  suggestions?: WelcomeSuggestion[];
  onSuggestionPress?: (text: string) => void;
  faceSize?: number;
  selectedCategory?: SearchCategory;
  onCategoryChange?: (category: SearchCategory) => void;
}

const CATEGORIES: { id: SearchCategory; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'academic', label: 'Academic' },
  { id: 'news', label: 'News' },
  { id: 'code', label: 'Code' },
  { id: 'social', label: 'Social' },
];

function CategoryTab({
  label,
  isSelected,
  onPress,
}: {
  label: string;
  isSelected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={
        isSelected
          ? 'rounded-lg px-3 h-8 flex-row items-center bg-muted'
          : 'rounded-lg px-3 h-8 flex-row items-center border border-border'
      }
    >
      <Text
        className={
          isSelected
            ? 'text-sm font-medium text-foreground'
            : 'text-sm font-medium text-muted-foreground opacity-80'
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}

function SuggestionCard({
  text,
  onPress,
}: {
  text: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row w-full items-center py-2 px-2 rounded-lg active:bg-muted hover:bg-muted"
    >
      <Text className="text-muted-foreground text-sm flex-1" numberOfLines={1}>
        {text}
      </Text>
      <ArrowRight size={16} className="text-muted-foreground ml-2" />
    </Pressable>
  );
}

export function ClarityWelcomeMessage({
  greeting,
  subtitle,
  suggestions = [],
  onSuggestionPress,
  faceSize = 56,
  selectedCategory = 'all',
  onCategoryChange,
}: ClarityWelcomeMessageProps) {
  return (
    <View className="w-full">
      {/* Logo area */}
      <View className="items-center mb-6">
        <ClarityLogo size={faceSize} expression="Greeting" />
        <Text className="text-2xl font-bold tracking-tight text-foreground mt-3">
          {greeting}
        </Text>
        {subtitle ? (
          <Text className="text-base text-muted-foreground mt-1">
            {subtitle}
          </Text>
        ) : null}
      </View>

      {/* Category Tabs */}
      {onCategoryChange && (
        <View className="flex-row flex-wrap gap-2 mt-4">
          {CATEGORIES.map((cat) => (
            <CategoryTab
              key={cat.id}
              label={cat.label}
              isSelected={selectedCategory === cat.id}
              onPress={() => onCategoryChange(cat.id)}
            />
          ))}
        </View>
      )}

      {/* Suggestion Cards */}
      {suggestions.length > 0 && (
        <Animated.View entering={FadeIn.duration(400)} className="mt-4">
          <View className="gap-1">
            {suggestions.map((item) => (
              <SuggestionCard
                key={item.id}
                text={item.description}
                onPress={() => onSuggestionPress?.(item.description)}
              />
            ))}
          </View>
        </Animated.View>
      )}
    </View>
  );
}
