import { usePersonalitySamplePhrase } from '@/lib/hooks/use-personality-sample-phrase';
import { useTranslation } from '@/lib/hooks/use-translation';
import {
  PERSONALITY_STYLES,
  PERSONALITY_STYLE_MAP,
  type PersonalityStyleId,
} from '@/lib/personality-styles';
import { Text } from '@oxy.so/bloom/typography';
import type { LucideIcon } from 'lucide-react-native';
import {
  Coffee,
  Flame,
  GraduationCap,
  Heart,
  Lightbulb,
  Sparkles,
  Zap,
} from 'lucide-react-native';
import { useCallback, useEffect } from 'react';
import { View } from 'react-native';
import { SettingsPreferenceSelect } from './preference-select';

const ICON_MAP: Record<string, LucideIcon> = {
  Heart,
  Zap,
  Coffee,
  Sparkles,
  Lightbulb,
  GraduationCap,
  Flame,
};

interface PersonalityStylePickerProps {
  selectedStyle: string;
  onSelectStyle: (id: PersonalityStyleId) => void;
}

export function PersonalityStylePicker({
  selectedStyle,
  onSelectStyle,
}: PersonalityStylePickerProps) {
  const { t } = useTranslation();
  const { phrase, isStreaming, fetchPhrase } = usePersonalitySamplePhrase();
  const currentStyleId: PersonalityStyleId = PERSONALITY_STYLE_MAP[
    selectedStyle as PersonalityStyleId
  ]
    ? (selectedStyle as PersonalityStyleId)
    : 'alia';

  useEffect(() => {
    fetchPhrase(currentStyleId);
  }, [currentStyleId, fetchPhrase]);

  const handleSelect = useCallback(
    (id: PersonalityStyleId) => {
      onSelectStyle(id);
      // fetchPhrase is triggered by the useEffect on currentStyleId
    },
    [onSelectStyle],
  );

  return (
    <View className="gap-3">
      <SettingsPreferenceSelect
        label={t('settings.personalityStyle.title')}
        value={currentStyleId}
        onChange={handleSelect}
        items={PERSONALITY_STYLES.map((style) => ({
          value: style.id,
          label: style.name,
        }))}
      />
      <Text className="text-body text-text-secondary">
        {phrase || '…'}
        {isStreaming ? ' |' : ''}
      </Text>
    </View>
  );
}
