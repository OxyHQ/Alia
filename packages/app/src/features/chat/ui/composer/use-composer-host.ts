import type { AliaChatLabels } from '@alia.onl/sdk';
import { useMemo } from 'react';
import { composerLabels } from '@/features/chat/model/composer-labels';
import { useTranslation } from '@/shared/i18n/use-translation';
import { speechLocale } from '@/features/voice/model/speech-locale';
import config from '@/shared/platform/config';

/**
 * What the app tells the SDK's `AliaComposer` about where it runs, for the screens that mount the
 * composer on its own (creating an agent, a skill or a task): the composer's copy, in the person's
 * language, the language dictation is transcribed in, and the Alia API that transcribes it
 * (`POST /v1/audio/transcriptions`, a Kaana model; nothing is recognized on the device). Spread it
 * on every `AliaComposer` the app mounts outside the conversation, which gets the same words from
 * `ChatLabelsProvider`.
 */
export function useComposerHost(): {
  labels: Partial<AliaChatLabels>;
  speechLanguage: string;
  apiUrl: string;
} {
  const { t } = useTranslation();
  const labels = useMemo(() => composerLabels(t), [t]);
  return { labels, speechLanguage: speechLocale(), apiUrl: config.apiUrl };
}
