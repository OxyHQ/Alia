import { Pressable, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Text } from '@/components/ui/text';
import Animated, { FadeIn } from 'react-native-reanimated';
import { ClarityLogo } from './ClarityLogo';
import type { WelcomeSuggestion } from './types';

export type { WelcomeSuggestion };

export interface ClarityWelcomeMessageProps {
  greeting: string;
  subtitle?: string;
  suggestions?: WelcomeSuggestion[];
  onSuggestionPress?: (text: string) => void;
  faceSize?: number;
}

export function ClarityWelcomeMessage({
  greeting,
  subtitle,
  suggestions = [],
  onSuggestionPress,
  faceSize = 64,
}: ClarityWelcomeMessageProps) {
  return (
    <View className="flex-1 items-center justify-center px-4">
      <View className="w-full max-w-2xl">
        {/* Face + Title */}
        <View className="items-start mb-8">
          <View className="mb-4">
            <ClarityLogo size={faceSize} expression="Greeting" />
          </View>
          <View className="space-y-2">
            <Text className="text-3xl font-bold tracking-tight text-foreground">
              {greeting}
            </Text>
            {subtitle ? (
              <Text className="text-xl font-medium text-muted-foreground">
                {subtitle}
              </Text>
            ) : null}
          </View>
        </View>

        {/* Suggestion Grid */}
        {suggestions.length > 0 && (
          <Animated.View entering={FadeIn.duration(400)}>
            <View className="flex-row flex-wrap gap-2">
              {suggestions.map((item) => (
                <Pressable
                  key={item.id}
                  className="flex-1 min-w-[35%] flex-col items-start rounded-3xl border border-border overflow-hidden active:bg-muted/50"
                  onPress={() => onSuggestionPress?.(item.description)}
                >
                  <BlurView intensity={60} tint="default" style={StyleSheet.absoluteFill} />
                  <View className="p-4 w-full">
                    <Text className="text-sm font-medium text-surface-foreground mb-1" numberOfLines={1}>
                      {item.title}
                    </Text>
                    <Text
                      className="text-xs text-muted-foreground line-clamp-1"
                      numberOfLines={1}
                    >
                      {item.description}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </Animated.View>
        )}
      </View>
    </View>
  );
}
