import type { SpeechPreferences } from '@alia.onl/sdk/runtime';
import { useMemo } from 'react';
import { useUserDataStore } from '@/features/memory/runtime/user-data-store';
import { speechLocale } from '@/features/voice/model/speech-locale';
import { useTranslation } from '@/shared/i18n/use-translation';

/**
 * How the person speaks and likes to be spoken to: the voice and the tone they chose, and the
 * language Alia reads aloud, transcribes and calls in — the app's language, not the device's.
 * The SDK's read-aloud, dictation and calls all take it from the runtime provider.
 */
export function useAliaSpeech(): SpeechPreferences {
  const voice = useUserDataStore((s) => s.memory?.preferences?.voice);
  const tone = useUserDataStore((s) => s.memory?.preferences?.tone);
  // `speechLocale` reads the catalogue's current language when called; keying on `locale` is what
  // makes a change of language reach a call or a dictation already mounted.
  const { locale } = useTranslation();
  return useMemo(
    () => ({
      voice: voice === 'male' ? 'male' : 'female',
      tone: tone === 'brief' ? 'brief' : tone === 'chill' ? 'chill' : 'default',
      language: speechLocale(),
    }),
    // biome-ignore lint/correctness/useExhaustiveDependencies: `locale` is the trigger for `speechLocale()`
    [voice, tone, locale],
  );
}
