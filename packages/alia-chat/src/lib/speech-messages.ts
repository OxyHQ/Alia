import type { VoiceServerErrorCode } from './voice-protocol';

/**
 * Every way dictation or a voice call can fail that a person is told about,
 * as a stable code (ADR 0017 §3, §7).
 *
 * - **Alia's**, sent by `/v1/voice/session` when it ends a call:
 *   `VoiceServerErrorCode` (`plan-required`, `credits-exhausted`,
 *   `realtime-*`, …).
 * - **The device's:** `mic-denied`, `mic-unavailable`, `connection-lost`, and
 *   `voice-unavailable` where this platform has no audio engine for a call.
 * - **Dictation's** (`POST /v1/audio/transcriptions`): `too-long` and
 *   `transcription-*`, beside the shared `mic-*` and `not-authenticated`.
 *
 * The hooks expose the code beside the English sentence so an app can say it in
 * its own language; the sentence stays for a consumer with no translations.
 * Nothing here is a recognizer's: speech is recognized by Kaana, never by the
 * browser or the operating system.
 */
export type VoiceErrorCode =
  | VoiceServerErrorCode
  | 'mic-denied'
  | 'mic-unavailable'
  | 'connection-lost'
  | 'voice-unavailable'
  | 'too-long'
  | 'transcription-unavailable'
  | 'transcription-limited'
  | 'transcription-rejected'
  | 'transcription-failed';

/** The English copy for each code. */
export const VOICE_ERROR_MESSAGES: Readonly<Record<VoiceErrorCode, string>> = {
  'not-authenticated': 'Not authenticated',
  'credential-not-supported': 'Voice is only available when you are signed in to Alia',
  'plan-required': 'Voice mode needs a paid plan',
  'credits-exhausted': "You've run out of credits for this call",
  'agent-unavailable': 'This agent is not available for a call',
  'invalid-request': 'The call could not be started',
  'resume-unavailable': 'The call could not be picked up again — start a new one',
  'realtime-unavailable': 'Voice is not available right now — try again later',
  'realtime-limited': 'Voice has reached its limit for now — try again later',
  'realtime-rejected': 'The call could not be started with these settings',
  'realtime-failed': 'The call failed — try again',
  'mic-denied': 'Microphone permission required',
  'mic-unavailable': 'The microphone could not be used — check your input devices',
  'connection-lost': 'The connection was lost',
  'voice-unavailable': 'Voice is not available on this device or browser',
  'too-long': 'That dictation was too long — five minutes at most',
  'transcription-unavailable': 'Dictation is not available right now',
  'transcription-limited': 'Dictation has reached its limit for now — try again later',
  'transcription-rejected': 'That recording could not be transcribed',
  'transcription-failed': 'Dictation failed — try again',
};
