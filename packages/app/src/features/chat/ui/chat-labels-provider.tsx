import { type AliaChatLabels, AliaChatLabelsProvider } from '@alia.onl/sdk';
import { useMemo, type ReactNode } from 'react';
import { composerLabels } from '@/features/chat/model/composer-labels';
import { voiceEndedText, voiceErrorText } from '@/features/voice/model/voice-error-text';
import { useTranslation } from '@/shared/i18n/use-translation';

/**
 * The SDK chat's words, in the person's language.
 *
 * The conversation, its thread and its voice call are the SDK's; the app supplies the catalogue.
 * `t` answers every string that is not one fixed field (the thread, its cards, the thought panel,
 * the work log), `locale` formats the dates and prices in it, and the fixed ones are the composer's
 * and the call's: the call bar, why a call failed or ended, the time limit near, and why a call
 * could not be opened. Mounted once above every screen that holds a chat.
 */
export function ChatLabelsProvider({ children }: { children: ReactNode }) {
  const { t, locale } = useTranslation();
  const labels = useMemo<Partial<AliaChatLabels>>(
    () => ({
      t,
      locale,
      newChat: t('chat.newChat'),
      greeting: t('welcome.greeting'),
      greetingNamed: (name) => t('welcome.greetingNamed', { name }),
      ...composerLabels(t),
      voiceControls: {
        connecting: t('voice.controls.connecting'),
        reconnecting: t('voice.controls.reconnecting'),
        connected: t('voice.controls.connected'),
        listening: t('voice.controls.listening'),
        muted: t('voice.controls.muted'),
        thinking: t('voice.controls.thinking'),
        usingTool: t('voice.controls.usingTool'),
        speaking: t('voice.controls.speaking'),
        mute: t('voice.controls.mute'),
        unmute: t('voice.controls.unmute'),
        end: t('voice.controls.end'),
      },
      voiceError: (code) => voiceErrorText(t, code) ?? t('voice.connectionFailed'),
      voiceEnded: (reason) => voiceEndedText(t, reason),
      voiceEndingSoon: t('voice.endingSoon'),
      voiceBlocked: (reason) =>
        reason === 'sign-in'
          ? t('voice.errors.not-authenticated')
          : reason === 'plan-required'
            ? t('subscribe.featureRequiresPlan', { feature: t('modes.voiceMode') })
            : t('usageLimit.outOfCreditsTitle'),
    }),
    [t, locale],
  );
  return <AliaChatLabelsProvider labels={labels}>{children}</AliaChatLabelsProvider>;
}
