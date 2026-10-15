import type { VoiceErrorCode } from '@alia.onl/sdk';
import type { VoiceCloseReason } from '@alia.onl/sdk/voice';

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

/**
 * Why a call ended without failing, in the app's language — `null` for a
 * hang-up (the person knows) and for `error` (the error says it). The others
 * have a key under `voice.ended`; `call-moved-elsewhere` is information, not an
 * error.
 */
export function voiceEndedText(
  t: (key: string) => string,
  reason: VoiceCloseReason | null | undefined,
): string | null {
  if (!reason || reason === 'hangup' || reason === 'error') return null;
  return t(`voice.ended.${reason}`);
}
