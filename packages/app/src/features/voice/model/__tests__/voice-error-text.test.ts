import { describe, expect, it } from 'vitest';
import { type VoiceErrorCode } from '@alia.onl/sdk';
import type { VoiceCloseReason } from '@alia.onl/sdk/voice';
import en from '@/shared/i18n/locales/en.json';
import es from '@/shared/i18n/locales/es.json';
import { voiceEndedText, voiceErrorText } from '@/features/voice/model/voice-error-text';

/**
 * Every way the SDK says dictation or a call failed has words in the app's
 * languages. The record is typed by the SDK's `VoiceErrorCode`, so a code the
 * SDK adds fails typecheck here until it is listed — and then this test until
 * both catalogs say it. A missing key would otherwise toast `voice.errors.…`.
 */
const EVERY_CODE: Record<VoiceErrorCode, true> = {
  'not-authenticated': true,
  'credential-not-supported': true,
  'plan-required': true,
  'credits-exhausted': true,
  'agent-unavailable': true,
  'invalid-request': true,
  'resume-unavailable': true,
  'realtime-unavailable': true,
  'realtime-limited': true,
  'realtime-rejected': true,
  'realtime-failed': true,
  'mic-denied': true,
  'mic-unavailable': true,
  'connection-lost': true,
  'voice-unavailable': true,
  'too-long': true,
  'transcription-unavailable': true,
  'transcription-limited': true,
  'transcription-rejected': true,
  'transcription-failed': true,
};

describe('voice errors in the app’s languages', () => {
  it.each([
    ['en', en.voice.errors],
    ['es', es.voice.errors],
  ])('%s has a non-empty sentence for every code', (_locale, errors) => {
    const catalog = errors as Record<string, string>;
    for (const code of Object.keys(EVERY_CODE)) {
      expect(catalog[code], code).toEqual(expect.any(String));
      expect(catalog[code]?.trim(), code).not.toBe('');
    }
  });

  it('asks the translator for the code’s key, and says nothing without a code', () => {
    const t = (key: string) => `t:${key}`;
    expect(voiceErrorText(t, 'realtime-unavailable')).toBe('t:voice.errors.realtime-unavailable');
    expect(voiceErrorText(t, null)).toBeNull();
  });

  it.each([
    ['en', en.voice.ended],
    ['es', es.voice.ended],
  ])('%s says why a call ended on its own', (_locale, ended) => {
    const catalog = ended as Record<string, string>;
    for (const reason of SAID_REASONS) {
      expect(catalog[reason], reason).toEqual(expect.any(String));
      expect(catalog[reason]?.trim(), reason).not.toBe('');
    }
  });

  it('says nothing for a hang-up or an error, and a moved call as an ending', () => {
    const t = (key: string) => `t:${key}`;
    expect(voiceEndedText(t, 'hangup')).toBeNull();
    expect(voiceEndedText(t, 'error')).toBeNull();
    expect(voiceEndedText(t, 'call-moved-elsewhere')).toBe('t:voice.ended.call-moved-elsewhere');
  });
});

/** Every reason a call ends with that the app says (a hang-up and an error are said otherwise). */
const SAID_REASONS: ReadonlyArray<Exclude<VoiceCloseReason, 'hangup' | 'error'>> = [
  'call-moved-elsewhere',
  'max-duration',
  'idle-timeout',
  'credits-exhausted',
  'server-shutdown',
];
