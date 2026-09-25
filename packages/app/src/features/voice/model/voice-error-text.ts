import type { VoiceErrorCode } from '@alia.onl/sdk';

/**
 * What went wrong with dictation or a call, in the app's language.
 *
 * The SDK reports a `VoiceErrorCode` beside its English sentence; every code
 * has a key under `voice.errors`. `null` when there is nothing to say.
 */
export function voiceErrorText(
  t: (key: string) => string,
  code: VoiceErrorCode | null | undefined,
): string | null {
  return code ? t(`voice.errors.${code}`) : null;
}
