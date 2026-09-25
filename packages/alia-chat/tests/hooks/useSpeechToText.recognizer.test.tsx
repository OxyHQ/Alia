import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SpeechRecognitionHandlers,
  SpeechRecognitionOptions,
  SpeechRecognizerChoice,
} from '../../src/lib/speech-recognition-types';

/**
 * Dictation asks the engine which recognizer knows the language before it
 * listens, and says what is really wrong when none can (#608, a Pixel 8a with
 * no speech language installed anywhere: `docs/native-validation.mdx` §8.4).
 */
const fx = vi.hoisted(() => ({
  choice: { lang: 'es-ES', silent: false } as SpeechRecognizerChoice,
  started: [] as Array<{ options: SpeechRecognitionOptions; handlers: SpeechRecognitionHandlers }>,
}));

vi.mock('../../src/lib/speech-recognition', () => ({
  isSpeechRecognitionAvailable: () => true,
  requestSpeechRecognitionPermission: async () => null,
  chooseSpeechRecognizer: async () => fx.choice,
  startSpeechRecognition: (options: SpeechRecognitionOptions, handlers: SpeechRecognitionHandlers) => {
    fx.started.push({ options, handlers });
    return { stop: vi.fn(), abort: vi.fn() };
  },
}));

import { useSpeechToText } from '../../src/hooks/useSpeechToText';

let latest: ReturnType<typeof useSpeechToText>;
function Harness() {
  latest = useSpeechToText({ lang: 'es-ES' });
  return null;
}

async function start(): Promise<void> {
  await act(async () => {
    TestRenderer.create(<Harness />);
  });
  await act(async () => {
    await latest.startRecording();
  });
}

describe('dictation picks its recognizer first', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fx.started = [];
  });

  it('listens on the chosen service, in the tag that service uses', async () => {
    fx.choice = { lang: 'es_ES', service: 'com.google.android.tts', silent: false };
    await start();
    expect(fx.started[0]?.options).toEqual({ lang: 'es_ES', service: 'com.google.android.tts' });
  });

  it('does not listen at all when no recognizer has the language', async () => {
    fx.choice = { failure: { code: 'language-not-supported' } };
    await start();
    expect(fx.started).toHaveLength(0);
    expect(latest.errorCode).toBe('speech-language');
    expect(latest.state).toBe('idle');
  });

  it('calls it the device, not the language, when no recognizer named any language', async () => {
    fx.choice = { lang: 'es-ES', silent: true };
    await start();
    await act(async () => {
      fx.started[0]!.handlers.onError({ code: 'language-not-supported' });
      fx.started[0]!.handlers.onEnd();
    });
    expect(latest.errorCode).toBe('speech-unsupported');
  });

  it('keeps a language error one where the recognizers were not all silent', async () => {
    fx.choice = { lang: 'es-ES', silent: false };
    await start();
    await act(async () => {
      fx.started[0]!.handlers.onError({ code: 'language-not-supported' });
      fx.started[0]!.handlers.onEnd();
    });
    expect(latest.errorCode).toBe('speech-language');
  });
});
