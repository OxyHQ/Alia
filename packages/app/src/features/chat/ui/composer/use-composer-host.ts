import { type AliaChatLabels } from '@alia.onl/sdk';
import { useMemo } from 'react';
import { useTranslation } from '@/shared/i18n/use-translation';
import { speechLocale } from '@/features/voice/model/speech-locale';
import config from '@/shared/platform/config';

/**
 * What the app tells the SDK's `AliaComposer` about where it runs: the composer's copy, in the
 * person's language, the language dictation is transcribed in, and the Alia API that transcribes
 * it (`POST /v1/audio/transcriptions`, a Kaana model; nothing is recognized on the device).
 * Spread it on every `AliaComposer` the app mounts.
 */
export function useComposerHost(): {
  labels: Partial<AliaChatLabels>;
  speechLanguage: string;
  apiUrl: string;
} {
  const { t } = useTranslation();
  const labels = useMemo<Partial<AliaChatLabels>>(
    () => ({
      composerMessage: t('composer.message'),
      composerAddMenu: t('composer.addMenu'),
      composerModes: t('composer.powerLevel'),
      composerVoice: t('composer.voice'),
      composerSend: t('composer.send'),
      composerStop: t('composer.stop'),
      composerRemove: t('composer.removeShort'),
      composerRetry: t('composer.retryShort'),
      composerUntitled: t('composer.untitled'),
      fileReadFailed: (name) => t('composer.readFailed', { name }),
      fileTooLarge: (name, limit) => t('composer.fileTooLarge', { name, limit }),
      fileEmpty: (name) => t('composer.fileEmpty', { name }),
      dropHint: t('composer.dropHint'),
      dropUnavailable: t('composer.dropUnavailable'),
      voiceError: (code) => t(`voice.errors.${code}`),
      dictationRemaining: (seconds) => t('voice.dictationRemaining', { seconds }),
    }),
    [t],
  );
  return { labels, speechLanguage: speechLocale(), apiUrl: config.apiUrl };
}
