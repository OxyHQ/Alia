import { useState, useCallback, useRef, useEffect } from 'react';
import { create } from 'zustand';
import {
  isSpeechRecognitionAvailable,
  requestSpeechRecognitionPermission,
  startSpeechRecognition,
} from '../lib/speech-recognition';
import type { SpeechRecognitionSession } from '../lib/speech-recognition-types';
import { speechFailureMessage } from '../lib/speech-messages';
import { defaultSpeechLanguage } from '../lib/speech-language';

// ============== OPTIONS ==============

export interface UseSTTOptions {
  /**
   * Language to recognize, as a BCP-47 tag (`es-ES`). Defaults to the
   * platform's own language. The Alia app passes its UI locale.
   */
  lang?: string;
}

// ============== INLINE STT STORE ==============

interface STTStoreState {
  isRecording: boolean;
  metering: number;
  setRecording: (v: boolean) => void;
  setMetering: (v: number) => void;
}

export const useSTTStore = create<STTStoreState>((set) => ({
  isRecording: false,
  metering: 0,
  setRecording: (isRecording) => set({ isRecording }),
  setMetering: (metering) => set({ metering }),
}));

// ============== HOOK ==============

type STTState = 'idle' | 'recording' | 'transcribing';

/** How long `stopAndTranscribe` waits for the engine's final words. */
const FINAL_RESULT_TIMEOUT_MS = 2_000;

/**
 * How many times one dictation may quietly re-open the recognizer.
 *
 * Browsers end a continuous session on their own — Chrome after a stretch of
 * silence or about a minute of audio — and the person is still looking at a
 * dictation bar that says it is listening. Re-opening keeps what was already
 * heard and carries on. The cap is what stops an engine that ends the instant
 * it starts from spinning.
 */
const MAX_SILENT_RESTARTS = 20;

/**
 * Dictation, recognized on the device.
 *
 * The public shape is the one the recorder-and-upload version had —
 * `startRecording`, `stopAndTranscribe`, `cancel`, the three states and
 * `useSTTStore`'s metering — so the composer and the dictation bar did not
 * change. What changed underneath: words arrive while the person speaks
 * (`speech-recognition.ts` on web, `.native.ts` on iOS/Android), so
 * `transcribing` is now the moment between "stop" and the engine's final
 * result rather than an upload, and there is no transcription endpoint.
 */
export function useSpeechToText(options: UseSTTOptions = {}) {
  const lang = options.lang ?? defaultSpeechLanguage();

  const [state, setState] = useState<STTState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isSupported] = useState(isSpeechRecognitionAvailable);

  const stateRef = useRef<STTState>('idle');
  const sessionRef = useRef<SpeechRecognitionSession | null>(null);
  /** Text from sessions that already ended during this dictation. */
  const earlierTextRef = useRef('');
  /** Text from the live session. */
  const currentTextRef = useRef('');
  const restartsRef = useRef(0);
  const endWaitersRef = useRef<Array<() => void>>([]);
  const lastMeteringRef = useRef(0);
  const mountedRef = useRef(true);

  const setPhase = useCallback((next: STTState) => {
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  }, []);

  // Sync recording state to store + reset metering on stop
  useEffect(() => {
    useSTTStore.getState().setRecording(state === 'recording');
    if (state !== 'recording') {
      lastMeteringRef.current = 0;
      useSTTStore.getState().setMetering(0);
    }
  }, [state]);

  const fullText = (): string =>
    `${earlierTextRef.current} ${currentTextRef.current}`.replace(/\s+/g, ' ').trim();

  const openSession = useCallback(() => {
    currentTextRef.current = '';
    let failed = false;
    sessionRef.current = startSpeechRecognition(
      { lang },
      {
        onResult: ({ transcript }) => {
          currentTextRef.current = transcript;
        },
        onLevel: (level) => {
          if (stateRef.current !== 'recording') return;
          // Epsilon guard: quiet should not thrash the store's subscribers.
          if (Math.abs(level - lastMeteringRef.current) < 0.02) return;
          lastMeteringRef.current = level;
          useSTTStore.getState().setMetering(level);
        },
        onError: (failure) => {
          const message = speechFailureMessage(failure);
          if (message === null) return;
          failed = true;
          if (mountedRef.current) setError(message);
        },
        onEnd: () => {
          sessionRef.current = null;
          earlierTextRef.current = fullText();
          currentTextRef.current = '';
          const waiters = endWaitersRef.current;
          endWaitersRef.current = [];
          for (const resolve of waiters) resolve();
          if (waiters.length > 0) return;

          // The engine ended on its own while the person is still dictating.
          if (stateRef.current !== 'recording') return;
          if (failed || restartsRef.current >= MAX_SILENT_RESTARTS) {
            setPhase('idle');
            return;
          }
          restartsRef.current += 1;
          openSession();
        },
      },
    );
  }, [lang, setPhase]);

  const startRecording = useCallback(async () => {
    if (stateRef.current !== 'idle') return;
    setError(null);

    if (!isSpeechRecognitionAvailable()) {
      setError(speechFailureMessage({ code: 'unsupported' }));
      return;
    }

    // Claim the state before the first await so a double tap cannot open two.
    setPhase('recording');
    const refusal = await requestSpeechRecognitionPermission();
    if ((stateRef.current as STTState) !== 'recording') return; // cancelled while asking
    if (refusal !== null) {
      setError(speechFailureMessage(refusal));
      setPhase('idle');
      return;
    }

    earlierTextRef.current = '';
    currentTextRef.current = '';
    restartsRef.current = 0;
    openSession();
  }, [openSession, setPhase]);

  const waitForEnd = useCallback((): Promise<void> => {
    if (sessionRef.current === null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        sessionRef.current?.abort();
        resolve();
      }, FINAL_RESULT_TIMEOUT_MS);
      endWaitersRef.current.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }, []);

  const stopAndTranscribe = useCallback(async (): Promise<string | null> => {
    if (stateRef.current !== 'recording') return null;
    setPhase('transcribing');
    const ended = waitForEnd();
    sessionRef.current?.stop();
    await ended;
    const text = fullText();
    earlierTextRef.current = '';
    currentTextRef.current = '';
    setPhase('idle');
    return text === '' ? null : text;
  }, [setPhase, waitForEnd]);

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    setPhase('idle');
    earlierTextRef.current = '';
    currentTextRef.current = '';
    session?.abort();
    setError(null);
  }, [setPhase]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stateRef.current = 'idle';
      sessionRef.current?.abort();
    };
  }, []);

  return {
    state,
    error,
    /** False where the platform cannot recognize speech at all (Firefox). */
    isSupported,
    startRecording,
    stopAndTranscribe,
    cancel,
    isRecording: state === 'recording',
    isTranscribing: state === 'transcribing',
  };
}
