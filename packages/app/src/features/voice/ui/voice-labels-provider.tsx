import { AliaChatLabelsProvider, type AliaChatLabels } from '@alia.onl/sdk';
import { useMemo, type ReactNode } from 'react';
import { voiceEndedText, voiceErrorText } from '@/features/voice/model/voice-error-text';
import { useTranslation } from '@/shared/i18n/use-translation';

/**
 * The words of the SDK's voice call, in the person's language: the call bar, why a call failed or
 * ended, the time limit near, and why a call could not be opened. The SDK's call says them; the
 * app only supplies the catalogue. Mounted once above every screen that can hold a call.
 */
export function VoiceLabelsProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const labels = useMemo<Partial<AliaChatLabels>>(
    () => ({
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
    [t],
  );
  return <AliaChatLabelsProvider labels={labels}>{children}</AliaChatLabelsProvider>;
}
