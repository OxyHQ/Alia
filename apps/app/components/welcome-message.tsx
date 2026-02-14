import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { useAuth } from "@oxyhq/services";
import { useMemo } from "react";
import { useTranslation } from "@/hooks/useTranslation";

type WelcomeMessageProps = {
  onSuggestionPress?: (message: string) => void;
};

export const WelcomeMessage = ({ onSuggestionPress }: WelcomeMessageProps) => {
  const { user, isAuthenticated } = useAuth();
  const { t } = useTranslation();

  const greeting = useMemo(() => {
    const greetings = t('welcome.greetings') as unknown as string[];
    const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
    const userName = user?.name?.first || user?.username || user?.email?.split('@')[0] || "there";
    return randomGreeting.replace("{{name}}", userName);
  }, [user, t]);

  const subtitle = useMemo(() => {
    const subtitles = t('welcome.subtitles') as unknown as string[];
    return subtitles[Math.floor(Math.random() * subtitles.length)];
  }, [t]);

  const suggestions = [
    {
      title: t('welcome.summarizeTitle'),
      description: t('welcome.summarizeDescription'),
    },
    {
      title: t('welcome.draftEmailTitle'),
      description: t('welcome.draftEmailDescription'),
    },
    {
      title: t('welcome.exploreIdeasTitle'),
      description: t('welcome.exploreIdeasDescription'),
    },
    {
      title: t('welcome.pythonCodeTitle'),
      description: t('welcome.pythonCodeDescription'),
    },
  ];

  return (
    <View className="flex-1 items-center justify-center px-4">
      <View className="w-full max-w-2xl">
        {/* Title */}
        <View className="items-start space-y-2 mb-8">
          <Text className="text-3xl font-bold tracking-tight text-foreground">
            {isAuthenticated ? greeting : t('welcome.appName')}
          </Text>
          <Text className="text-xl font-medium text-muted-foreground">
            {isAuthenticated ? subtitle : t('welcome.defaultSubtitle')}
          </Text>
        </View>

        {/* Suggestion Grid */}
        <View className="flex-row flex-wrap gap-2">
          {suggestions.map((item, index) => (
            <Pressable
              key={index}
              className="flex-1 min-w-[35%] flex-col items-start rounded-3xl border border-border bg-surface p-4 active:bg-muted/50"
              onPress={() => onSuggestionPress?.(item.description)}
            >
              <Text className="text-sm font-medium text-surface-foreground mb-1">
                {item.title}
              </Text>
              <Text
                className="text-xs text-muted-foreground line-clamp-1"
                numberOfLines={1}
              >
                {item.description}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
};
