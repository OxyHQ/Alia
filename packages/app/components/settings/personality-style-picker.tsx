import { usePersonalitySamplePhrase } from '@/lib/hooks/use-personality-sample-phrase';
import { useTranslation } from '@/lib/hooks/use-translation';
import {
  PERSONALITY_STYLES,
  PERSONALITY_STYLE_MAP,
  type PersonalityStyleId,
} from '@/lib/personality-styles';
import type { SettingsRowData } from '@oxy.so/bloom/settings-modal';
import { useEffect } from 'react';
import { SettingsPreferenceSelect } from './preference-select';

interface PersonalityStyleRowOptions {
  selectedStyle: string;
  onSelectStyle: (id: PersonalityStyleId) => void;
}

/**
 * The personality row, shaped like the story's "Review provider" row: the
 * compact select on the right, and the chosen style's streamed sample phrase
 * as the row's description.
 */
export function usePersonalityStyleRow({
  selectedStyle,
  onSelectStyle,
}: PersonalityStyleRowOptions): SettingsRowData {
  const { t } = useTranslation();
  const { phrase, isStreaming, fetchPhrase } = usePersonalitySamplePhrase();
  const currentStyleId: PersonalityStyleId = PERSONALITY_STYLE_MAP[
    selectedStyle as PersonalityStyleId
  ]
    ? (selectedStyle as PersonalityStyleId)
    : 'alia';

  // A new style fetches its sample phrase.
  useEffect(() => {
    fetchPhrase(currentStyleId);
  }, [currentStyleId, fetchPhrase]);

  return {
    key: 'tone',
    label: t('settings.personalityStyle.title'),
    description: `${phrase || '…'}${isStreaming ? ' |' : ''}`,
    control: (
      <SettingsPreferenceSelect
        label={t('settings.personalityStyle.title')}
        value={currentStyleId}
        onChange={onSelectStyle}
        items={PERSONALITY_STYLES.map((style) => ({
          value: style.id,
          label: t(`settings.personalityStyle.styles.${style.id}.name`),
        }))}
      />
    ),
  };
}
