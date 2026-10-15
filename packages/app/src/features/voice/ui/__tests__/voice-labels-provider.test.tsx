import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

/** The catalogue the SDK's call speaks through: every word is a key that went through `t`. */
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => `t:${key}` }),
}));
const seen = vi.hoisted(() => ({ labels: null as null | Record<string, never> }));
vi.mock('@alia.onl/sdk', () => ({
  AliaChatLabelsProvider: ({ labels }: { labels: Record<string, never> }) => {
    seen.labels = labels;
    return null;
  },
}));

import { VoiceLabelsProvider } from '@/features/voice/ui/voice-labels-provider';

describe('VoiceLabelsProvider', () => {
  it('says the call bar, its failures and its endings in the app’s language', () => {
    act(() => {
      create(React.createElement(VoiceLabelsProvider, null, null));
    });
    const labels = seen.labels as unknown as {
      voiceControls: Record<string, string>;
      voiceError: (code: string) => string;
      voiceEnded: (reason: string) => string | null;
      voiceEndingSoon: string;
      voiceBlocked: (reason: string) => string;
    };
    expect(labels.voiceControls.listening).toBe('t:voice.controls.listening');
    expect(labels.voiceError('mic-denied')).toBe('t:voice.errors.mic-denied');
    expect(labels.voiceEnded('call-moved-elsewhere')).toBe('t:voice.ended.call-moved-elsewhere');
    expect(labels.voiceEnded('hangup')).toBeNull();
    expect(labels.voiceEndingSoon).toBe('t:voice.endingSoon');
    expect(labels.voiceBlocked('credits-exhausted')).toBe('t:usageLimit.outOfCreditsTitle');
  });
});
