/**
 * The composer's microphone: record a clip, then transcribe it with a Kaana
 * transcription model through Alia (`POST /v1/audio/transcriptions`, ADR 0017
 * §7). Free on every plan, five minutes per clip at most.
 *
 *   idle → requesting-permission → recording → transcribing → idle (text)
 *                                                           ↘ error { code }
 *
 * - `recording` is entered only once the recorder reports it started; the
 *   level meter is the real recorder's.
 * - The text arrives after the person stops — `onText` — and never partially:
 *   a failed transcription inserts nothing and keeps the clip for ONE `retry()`.
 * - At five minutes the recording stops by itself and is transcribed; the
 *   remaining time is exposed for the last 30 seconds.
 *
 * Nothing is recognized on the device.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useOxy } from '@oxy.so/services/ui/client';
import {
  dictationFailureCode,
  MAX_DICTATION_MS,
  requestTranscription,
  type DictationClip,
} from '../lib/dictation';
import { DictationRecorderError, useDictationRecorder } from '../lib/dictation-recorder';
import { defaultSpeechLanguage } from '../lib/speech-language';
import { VOICE_ERROR_MESSAGES, type VoiceErrorCode } from '../lib/speech-messages';

const API_URL = process.env.EXPO_PUBLIC_ALIA_API_URL ?? 'https://api.alia.onl';

/** The remaining time is shown from here on. */
const COUNTDOWN_FROM_MS = 30_000;
const CLOCK_MS = 250;

export type DictationState =
  | 'idle'
  | 'requesting-permission'
  | 'recording'
  | 'transcribing'
  | 'error';

export interface UseDictationOptions {
  apiUrl?: string;
  /** Bearer; defaults to the surrounding Oxy session's. */
  accessToken?: string;
  /** Language spoken (BCP-47); defaults to the platform's. The Alia app passes its own. */
  lang?: string;
  /** The transcribed text, once — after a stop, the five-minute stop, or a retry. */
  onText?: (text: string) => void;
}

interface DictationStoreState {
  isRecording: boolean;
  metering: number;
  setRecording: (isRecording: boolean) => void;
  setMetering: (metering: number) => void;
}

/**
 * Whether the composer is recording, and its level: what the ambient field and
 * the app's turn actions read without holding the hook.
 */
export const useDictationStore = create<DictationStoreState>((set) => ({
  isRecording: false,
  metering: 0,
  setRecording: (isRecording) => set({ isRecording }),
  setMetering: (metering) => set({ metering }),
}));

export function useDictation(options: UseDictationOptions = {}) {
  const { oxyServices } = useOxy();
  const recorder = useDictationRecorder();
  const [state, setStateValue] = useState<DictationState>('idle');
  const [errorCode, setErrorCode] = useState<VoiceErrorCode | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [canRetry, setCanRetry] = useState(false);

  const stateRef = useRef<DictationState>('idle');
  const mountedRef = useRef(true);
  const startedAtRef = useRef(0);
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const capRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failedClipRef = useRef<DictationClip | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastMeteringRef = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const setState = useCallback((next: DictationState) => {
    stateRef.current = next;
    if (mountedRef.current) setStateValue(next);
  }, []);

  const report = useCallback(
    (code: VoiceErrorCode | null) => {
      if (mountedRef.current) setErrorCode(code);
      if (code !== null) setState('error');
    },
    [setState],
  );

  useEffect(() => {
    const store = useDictationStore.getState();
    store.setRecording(state === 'recording');
    if (state !== 'recording') {
      lastMeteringRef.current = 0;
      store.setMetering(0);
    }
  }, [state]);

  const clearClock = useCallback((): void => {
    if (clockRef.current !== null) clearInterval(clockRef.current);
    if (capRef.current !== null) clearTimeout(capRef.current);
    clockRef.current = null;
    capRef.current = null;
  }, []);

  const transcribe = useCallback(
    async (clip: DictationClip): Promise<string | null> => {
      const token = optionsRef.current.accessToken || oxyServices.session.accessToken || '';
      if (token === '') {
        failedClipRef.current = null;
        if (mountedRef.current) setCanRetry(false);
        report('not-authenticated');
        return null;
      }
      setState('transcribing');
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await requestTranscription({
          apiUrl: optionsRef.current.apiUrl || API_URL,
          token,
          clip,
          language: optionsRef.current.lang ?? defaultSpeechLanguage(),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return null;
        failedClipRef.current = null;
        if (mountedRef.current) setCanRetry(false);
        setState('idle');
        const text = result.text.trim();
        if (text === '') return null;
        optionsRef.current.onText?.(text);
        return text;
      } catch (caught: unknown) {
        if (controller.signal.aborted) return null;
        const code = dictationFailureCode(caught);
        // Kept for one retry, unless retrying cannot change the answer.
        const keep = code !== 'too-long' && code !== 'not-authenticated';
        failedClipRef.current = keep ? clip : null;
        if (mountedRef.current) setCanRetry(keep);
        report(code);
        return null;
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [oxyServices, report, setState],
  );

  const stop = useCallback(async (): Promise<string | null> => {
    if (stateRef.current !== 'recording') return null;
    clearClock();
    setState('transcribing');
    let clip: DictationClip | null;
    try {
      clip = await recorder.stop();
    } catch {
      report('mic-unavailable');
      return null;
    }
    if (clip === null) {
      setState('idle');
      return null;
    }
    if (clip.durationMs > MAX_DICTATION_MS + 1_000) {
      report('too-long');
      return null;
    }
    return transcribe(clip);
  }, [clearClock, recorder, report, setState, transcribe]);

  const stopRef = useRef(stop);
  stopRef.current = stop;

  const start = useCallback(async (): Promise<void> => {
    if (stateRef.current !== 'idle' && stateRef.current !== 'error') return;
    if (mountedRef.current) {
      setErrorCode(null);
      setCanRetry(false);
      setElapsedMs(0);
    }
    failedClipRef.current = null;
    setState('requesting-permission');
    try {
      await recorder.start((level) => {
        if (stateRef.current !== 'recording') return;
        // Quiet should not thrash the store's subscribers.
        if (Math.abs(level - lastMeteringRef.current) < 0.02) return;
        lastMeteringRef.current = level;
        useDictationStore.getState().setMetering(level);
      });
    } catch (caught: unknown) {
      if ((stateRef.current as DictationState) !== 'requesting-permission') return;
      report(caught instanceof DictationRecorderError ? caught.code : 'mic-unavailable');
      return;
    }
    if ((stateRef.current as DictationState) !== 'requesting-permission') {
      // Cancelled while the permission was asked.
      recorder.cancel();
      return;
    }
    startedAtRef.current = Date.now();
    setState('recording');
    clockRef.current = setInterval(() => {
      if (mountedRef.current) setElapsedMs(Date.now() - startedAtRef.current);
    }, CLOCK_MS);
    capRef.current = setTimeout(() => {
      void stopRef.current();
    }, MAX_DICTATION_MS);
  }, [recorder, report, setState]);

  const retry = useCallback(async (): Promise<string | null> => {
    const clip = failedClipRef.current;
    if (clip === null || stateRef.current === 'recording' || stateRef.current === 'transcribing')
      return null;
    // One retry: whatever it answers, the clip is not kept for another.
    failedClipRef.current = null;
    if (mountedRef.current) {
      setCanRetry(false);
      setErrorCode(null);
    }
    const text = await transcribe(clip);
    failedClipRef.current = null;
    if (mountedRef.current) setCanRetry(false);
    return text;
  }, [transcribe]);

  const cancel = useCallback(() => {
    clearClock();
    abortRef.current?.abort();
    abortRef.current = null;
    if (stateRef.current === 'recording' || stateRef.current === 'requesting-permission')
      recorder.cancel();
    failedClipRef.current = null;
    if (mountedRef.current) {
      setErrorCode(null);
      setCanRetry(false);
    }
    setState('idle');
  }, [clearClock, recorder, setState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearClock();
      abortRef.current?.abort();
      const wasRecording =
        stateRef.current === 'recording' || stateRef.current === 'requesting-permission';
      stateRef.current = 'idle';
      if (wasRecording) recorder.cancel();
      // The store outlives this hook: a composer unmounted mid-dictation (the
      // call bar replacing it) must not leave the field reading "recording".
      useDictationStore.getState().setRecording(false);
      useDictationStore.getState().setMetering(0);
    };
  }, [clearClock, recorder]);

  const remaining = MAX_DICTATION_MS - elapsedMs;
  return {
    state,
    /** What went wrong, in English. */
    error: errorCode === null ? null : VOICE_ERROR_MESSAGES[errorCode],
    /** The same, as a code an app can translate. */
    errorCode,
    /** Since the recording started. */
    elapsedMs,
    /** Left before the five-minute stop, in the last 30 seconds; else `null`. */
    remainingMs:
      state === 'recording' && remaining <= COUNTDOWN_FROM_MS ? Math.max(0, remaining) : null,
    /** A failed transcription kept its clip for one more try. */
    canRetry,
    start,
    stop,
    retry,
    cancel,
    isRecording: state === 'recording',
    isTranscribing: state === 'transcribing',
  };
}
