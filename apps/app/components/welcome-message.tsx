import { Pressable, StyleSheet } from "react-native";
import { BlurView } from "expo-blur";
import { Text } from "@/components/ui/text";
import { useAuth } from "@oxyhq/services";
import { useMemo } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { useWelcomeSuggestions, useRecordSuggestionUsage } from "@/lib/hooks/use-suggestions";
import Animated, { FadeIn } from "react-native-reanimated";
import { View } from "react-native";
import { AliaFace } from "@/components/alia-face";
import { useUserDataStore } from "@/lib/stores/user-data-store";
import { PERSONALITY_STYLE_MAP } from "@/lib/personality-styles";

type TimeOfDay = "morning" | "afternoon" | "evening";

function getTimeOfDay(): TimeOfDay {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  return "evening";
}

const PAIRS_COUNT = 8;

type WelcomeMessageProps = {
  onSuggestionPress?: (message: string) => void;
};

export const WelcomeMessage = ({ onSuggestionPress }: WelcomeMessageProps) => {
  const { user, isAuthenticated } = useAuth();
  const { t } = useTranslation();
  const { data: apiSuggestions } = useWelcomeSuggestions();
  const recordUsage = useRecordSuggestionUsage();

  const tone = useUserDataStore(s => s.memory?.preferences?.tone);
  const activeStyle = tone && tone !== 'alia' ? PERSONALITY_STYLE_MAP[tone as keyof typeof PERSONALITY_STYLE_MAP] : null;

  const timeOfDay = useMemo(() => getTimeOfDay(), []);
  const pairIndex = useMemo(() => Math.floor(Math.random() * PAIRS_COUNT), []);

  const userName = user?.name?.first || user?.username || user?.email?.split('@')[0] || "there";
  const greeting = t(`welcome.${timeOfDay}Greetings.${pairIndex}`, { name: userName });
  const styleSubtitleIndex = useMemo(
    () => activeStyle ? Math.floor(Math.random() * activeStyle.subtitles.length) : 0,
    [activeStyle]
  );
  const subtitle = activeStyle
    ? activeStyle.subtitles[styleSubtitleIndex]
    : t(`welcome.${timeOfDay}Subtitles.${pairIndex}`);

  const suggestions = (apiSuggestions || []).map(s => ({
    suggestionId: s.suggestionId,
    title: s.title,
    description: s.description || s.text,
  }));

  return (
    <View className="flex-1 items-center justify-center px-4">
      <View className="w-full max-w-2xl">
        {/* Face + Title */}
        <View className="items-start mb-8">
          <View className="mb-4">
            <AliaFace size={64} expression="Greeting" />
          </View>
          <View className="space-y-2">
            <Text className="text-3xl font-bold tracking-tight text-foreground">
              {isAuthenticated ? greeting : t('welcome.appName')}
            </Text>
            <Text className="text-xl font-medium text-muted-foreground">
              {isAuthenticated ? subtitle : t('welcome.defaultSubtitle')}
            </Text>
          </View>
        </View>

        {/* Suggestion Grid - fade in when loaded from backend */}
        {suggestions.length > 0 && (
          <Animated.View entering={FadeIn.duration(400)}>
            <View className="flex-row flex-wrap gap-2">
              {suggestions.map((item) => (
                <Pressable
                  key={item.suggestionId}
                  className="flex-1 min-w-[35%] flex-col items-start rounded-3xl border border-border overflow-hidden active:bg-muted/50"
                  onPress={() => {
                    recordUsage.mutate(item.suggestionId);
                    onSuggestionPress?.(item.description);
                  }}
                >
                  <BlurView intensity={60} tint="default" experimentalBlurMethod="dimezisBlurView" style={StyleSheet.absoluteFill} />
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
};
