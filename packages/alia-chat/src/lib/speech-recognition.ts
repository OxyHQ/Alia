/**
 * On-device speech recognition for the web: the browser's Web Speech API.
 *
 * Metro resolves `speech-recognition.native.ts` on iOS and Android, so this
 * file is what a web bundle — and every test — gets. See
 * `speech-recognition-types.ts` for the contract both implement.
 *
 * ## Why a microphone stream is opened beside the recognizer
 *
 * The Web Speech API reports words, not sound: there is no level event, and a
 * refused or missing microphone surfaces as a bare `not-allowed` or
 * `audio-capture` with nothing to tell "blocked" from "busy". Opening the
 * microphone first with `getUserMedia` answers both. It is where the browser
 * asks for permission (once — the recognizer shares the origin's grant), its
 * DOMException names say exactly what is wrong, and an `AnalyserNode` on the
 * stream is the honest level the dictation trace and the voice field move to.
 * The stream is never recorded or sent anywhere.
 *
 * ## Support
 *
 * Chromium browsers and Safari implement it (Chrome as `webkitSpeechRecognition`
 * and through a Google speech service; Safari through Apple's). Firefox does
 * not, and `isSpeechRecognitionAvailable()` says so before anything asks for a
 * microphone.
 */

import { levelFromDbfs } from './audio-level';
import type {
  SpeechRecognitionFailure,
  SpeechRecognitionFailureCode,
  SpeechRecognitionHandlers,
  SpeechRecognitionOptions,
  SpeechRecognitionSession,
} from './speech-recognition-types';

// ── The slice of the Web Speech API this uses ──
// Declared here rather than taken from lib.dom: TypeScript's DOM library does
// not ship the prefixed constructor, and the unprefixed one is not everywhere.

interface WebSpeechAlternative { readonly transcript: string }
interface WebSpeechResult { readonly isFinal: boolean; readonly length: number; readonly [index: number]: WebSpeechAlternative }
interface WebSpeechResultList { readonly length: number; readonly [index: number]: WebSpeechResult }
interface WebSpeechResultEvent { readonly results: WebSpeechResultList }
interface WebSpeechErrorEvent { readonly error: string; readonly message?: string }

interface WebSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: WebSpeechResultEvent) => void) | null;
  onerror: ((event: WebSpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type WebSpeechRecognitionConstructor = new () => WebSpeechRecognition;

function recognitionConstructor(): WebSpeechRecognitionConstructor | null {
  const scope = globalThis as unknown as {
    SpeechRecognition?: WebSpeechRecognitionConstructor;
    webkitSpeechRecognition?: WebSpeechRecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** Whether this browser can recognize speech at all. Firefox cannot. */
export function isSpeechRecognitionAvailable(): boolean {
  return recognitionConstructor() !== null;
}

/**
 * Ask for the microphone before a session needs it.
 *
 * The browser asks once per origin; `startSpeechRecognition` opens the stream
 * itself, so this is only for callers that want the answer up front (voice mode
 * does, so a refusal ends the call before it starts rather than on the first
 * word).
 */
export async function requestSpeechRecognitionPermission(): Promise<SpeechRecognitionFailure | null> {
  if (!isSpeechRecognitionAvailable()) return { code: 'unsupported' };
  const media = globalThis.navigator?.mediaDevices;
  if (media?.getUserMedia === undefined) return null;
  try {
    const stream = await media.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return null;
  } catch (error: unknown) {
    return mediaFailure(error);
  }
}

function domErrorName(error: unknown): string {
  // A DOMException is not always `instanceof Error`, so read `.name` off the object.
  if (typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string') {
    return error.name;
  }
  return '';
}

function mediaFailure(error: unknown): SpeechRecognitionFailure {
  const name = domErrorName(error);
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return { code: 'not-allowed', detail: name };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'NotReadableError':
    case 'TrackStartError':
      return { code: 'audio-capture', detail: name };
    default:
      return { code: 'other', detail: name || 'getUserMedia failed' };
  }
}

function recognitionFailure(event: WebSpeechErrorEvent): SpeechRecognitionFailure {
  const map: Record<string, SpeechRecognitionFailureCode> = {
    'not-allowed': 'not-allowed',
    'service-not-allowed': 'not-allowed',
    'audio-capture': 'audio-capture',
    network: 'network',
    'language-not-supported': 'language-not-supported',
    'no-speech': 'no-speech',
    aborted: 'aborted',
  };
  return { code: map[event.error] ?? 'other', detail: event.error };
}

/** Everything heard so far, as one string: Chrome segments carry their own leading spaces. */
function transcriptOf(results: WebSpeechResultList): { transcript: string; isFinal: boolean } {
  let transcript = '';
  let isFinal = results.length > 0;
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result === undefined) continue;
    transcript += result[0]?.transcript ?? '';
    if (!result.isFinal) isFinal = false;
  }
  return { transcript: transcript.replace(/\s+/g, ' ').trim(), isFinal };
}

const LEVEL_INTERVAL_MS = 100;

/** An analyser on the microphone, polled on a clock. Returns its teardown. */
function meterStream(stream: MediaStream, onLevel: (level: number) => void): () => void {
  const AudioContextCtor = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
  if (AudioContextCtor === undefined) return () => undefined;
  let context: AudioContext;
  try {
    context = new AudioContextCtor();
  } catch {
    return () => undefined;
  }
  if (context.state === 'suspended') context.resume().catch(() => undefined);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let index = 0; index < buffer.length; index += 1) sum += buffer[index] * buffer[index];
    const rms = Math.sqrt(sum / buffer.length);
    onLevel(rms > 0 ? levelFromDbfs(20 * Math.log10(rms)) : 0);
  }, LEVEL_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    context.close().catch(() => undefined);
  };
}

/**
 * Listen until stopped.
 *
 * Continuous with interim results: the caller decides when an utterance is
 * over (voice mode on a silence timer, dictation on the stop button), because
 * the browser's own end-of-speech detection cuts people off mid-thought.
 */
export function startSpeechRecognition(
  options: SpeechRecognitionOptions,
  handlers: SpeechRecognitionHandlers,
): SpeechRecognitionSession {
  let recognition: WebSpeechRecognition | null = null;
  let stream: MediaStream | null = null;
  let stopMeter: (() => void) | null = null;
  let ended = false;
  let stopRequested: 'stop' | 'abort' | null = null;

  const release = (): void => {
    stopMeter?.();
    stopMeter = null;
    if (stream !== null) for (const track of stream.getTracks()) track.stop();
    stream = null;
  };

  const finish = (): void => {
    if (ended) return;
    ended = true;
    release();
    handlers.onLevel?.(0);
    handlers.onEnd();
  };

  const fail = (failure: SpeechRecognitionFailure): void => {
    if (ended) return;
    handlers.onError(failure);
    finish();
  };

  void (async () => {
    const Recognition = recognitionConstructor();
    if (Recognition === null) {
      fail({ code: 'unsupported' });
      return;
    }

    const media = globalThis.navigator?.mediaDevices;
    if (media?.getUserMedia !== undefined) {
      try {
        stream = await media.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (error: unknown) {
        fail(mediaFailure(error));
        return;
      }
      if (stopRequested !== null) {
        finish();
        return;
      }
      if (handlers.onLevel !== undefined) stopMeter = meterStream(stream, handlers.onLevel);
    }

    const instance = new Recognition();
    recognition = instance;
    instance.lang = options.lang;
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;
    instance.onresult = (event) => {
      if (ended) return;
      handlers.onResult(transcriptOf(event.results));
    };
    instance.onerror = (event) => {
      if (ended) return;
      const failure = recognitionFailure(event);
      if (failure.code === 'aborted') return;
      handlers.onError(failure);
    };
    instance.onend = finish;
    try {
      instance.start();
    } catch (error: unknown) {
      fail({ code: 'other', detail: domErrorName(error) || 'start failed' });
      return;
    }
    if (stopRequested === 'stop') instance.stop();
    if (stopRequested === 'abort') instance.abort();
  })();

  return {
    stop() {
      if (ended) return;
      stopRequested = 'stop';
      recognition?.stop();
    },
    abort() {
      if (ended) return;
      stopRequested = 'abort';
      if (recognition === null) return;
      recognition.abort();
    },
  };
}
