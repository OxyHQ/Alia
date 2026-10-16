import type { AliaChatLabels } from '@alia.onl/sdk';

/** The app's translator, as a parameter: pure, so a hook and a provider can both ask for the words. */
type Translate = (key: string, params?: Record<string, unknown>) => string;

/** The words of the SDK's composer, in the person's language. */
export function composerLabels(t: Translate): Partial<AliaChatLabels> {
  return {
    placeholder: (name) => t('composer.placeholder', { name }),
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
  };
}
