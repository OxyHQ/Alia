import { describe, expect, it } from 'vitest';
import type { VoiceErrorCode } from '@alia.onl/sdk';
import en from '@/shared/i18n/locales/en.json';
import es from '@/shared/i18n/locales/es.json';
import { voiceErrorText } from '@/features/voice/model/voice-error-text';

/**
 * Every way the SDK says dictation or a call failed has words in the app's
 * languages. The record is typed by the SDK's `VoiceErrorCode`, so a code the
 * SDK adds fails typecheck here until it is listed — and then this test until
 * both catalogs say it. A missing key would otherwise toast `voice.errors.…`.
 */
const EVERY_CODE: Record<VoiceErrorCode, true> = {
  'speech-unsupported': true,
  'microphone-denied': true,
  'microphone-busy': true,
  'microphone-missing': true,
  'speech-network': true,
  'speech-language': true,
  'speech-failed': true,
  'voice-unavailable': true,
  'not-authenticated': true,
  'turn-failed': true,
  'no-answer': true,
  'not-played': true,
  'synthesis-unavailable': true,
  'synthesis-limited': true,
  'synthesis-rejected': true,
  'synthesis-failed': true,
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
    expect(voiceErrorText(t, 'synthesis-unavailable')).toBe('t:voice.errors.synthesis-unavailable');
    expect(voiceErrorText(t, null)).toBeNull();
  });
});
