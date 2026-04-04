import { useMemo, useCallback } from "react";
import { useAuth } from "@oxyhq/services";
import { useTranslation } from "@/hooks/useTranslation";
import { useWelcomeSuggestions, useRecordSuggestionUsage } from "@/lib/hooks/use-suggestions";
import { useUserDataStore } from "@/lib/stores/user-data-store";
import { PERSONALITY_STYLE_MAP } from "@/lib/personality-styles";
import { ClarityWelcomeMessage } from '@/lib/sdk';

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
  const activeStyle = tone && tone !== 'clarity' ? PERSONALITY_STYLE_MAP[tone as keyof typeof PERSONALITY_STYLE_MAP] : null;

  const timeOfDay = useMemo(() => getTimeOfDay(), []);
  const pairIndex = useMemo(() => Math.floor(Math.random() * PAIRS_COUNT), []);

  const userName = user?.name?.first || user?.username || user?.email?.split('@')[0] || "there";
  const greeting = isAuthenticated
    ? t(`welcome.${timeOfDay}Greetings.${pairIndex}`, { name: userName })
    : t('welcome.appName');

  const styleSubtitleIndex = useMemo(
    () => activeStyle ? Math.floor(Math.random() * activeStyle.subtitles.length) : 0,
    [activeStyle]
  );
  const subtitle = isAuthenticated
    ? (activeStyle ? activeStyle.subtitles[styleSubtitleIndex] : t(`welcome.${timeOfDay}Subtitles.${pairIndex}`))
    : t('welcome.defaultSubtitle');

  const suggestions = useMemo(() =>
    (apiSuggestions || []).map(s => ({
      id: s.suggestionId,
      title: s.title,
      description: s.description || s.text,
    })),
    [apiSuggestions]
  );

  const recordUsageMutate = recordUsage.mutate;
  const handleSuggestionPress = useCallback((text: string) => {
    const match = suggestions.find(s => s.description === text);
    if (match) recordUsageMutate(match.id);
    onSuggestionPress?.(text);
  }, [onSuggestionPress, suggestions, recordUsageMutate]);

  return (
    <ClarityWelcomeMessage
      greeting={greeting}
      subtitle={subtitle}
      suggestions={suggestions}
      onSuggestionPress={handleSuggestionPress}
    />
  );
};
