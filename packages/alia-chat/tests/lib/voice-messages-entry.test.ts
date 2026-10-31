import { describe, expect, it } from 'vitest';
import { VOICE_ERROR_MESSAGES as entryMessages } from '../../src/voice-messages';
import { VOICE_ERROR_MESSAGES } from '../../src/lib/speech-messages';

describe('voice messages entry', () => {
  it('exposes the same messages used by the voice and dictation hooks', () => {
    expect(entryMessages).toBe(VOICE_ERROR_MESSAGES);
    expect(entryMessages['mic-denied']).toBe('Microphone permission required');
    expect(entryMessages['transcription-failed']).toBe('Dictation failed — try again');
  });
});
