/**
 * On-device speech recognition for iOS and Android, through
 * `expo-speech-recognition` (Apple's Speech framework, Android's
 * `SpeechRecognizer`). Metro picks this file over `speech-recognition.ts` on
 * native; the contract is `speech-recognition-types.ts`.
 *
 * `expo-speech-recognition` is a peer of the SDK and a native module: an app
 * must depend on it (the root entry's dictation reaches this file) and list its
 * config plugin (which writes `NSSpeechRecognitionUsageDescription`,
 * `NSMicrophoneUsageDescription` and Android's `RECORD_AUDIO` plus the
 * recognizer-package visibility query), then ship a new native build.
 *
 * The module is a process-wide singleton — one recognition at a time — so the
 * hooks never start a session before the previous one has reported `onEnd`. A
 * late `end` from an aborted session would otherwise land on its successor's
 * listeners.
 */

import type { ExpoSpeechRecognitionErrorCode, ExpoSpeechRecognitionModule as NativeModule } from 'expo-speech-recognition';
import {
  clampLevel,
  type SpeechRecognitionFailure,
  type SpeechRecognitionFailureCode,
  type SpeechRecognitionHandlers,
  type SpeechRecognitionOptions,
  type SpeechRecognitionSession,
} from './speech-recognition-types';

type SpeechModule = typeof NativeModule;

let loaded: SpeechModule | null | undefined;

/**
 * The native module, loaded on first use — never at import.
 *
 * `expo-speech-recognition` calls `requireNativeModule` when it is imported,
 * which THROWS in a binary built before the module was added (an older dev
 * client, Expo Go). This file is reachable from the SDK's root entry through
 * dictation, so a top-level import would take the whole app down in such a
 * build over a feature nobody had touched yet. Loaded here, the same build
 * answers "not available" and everything else keeps working.
 */
function speechModule(): SpeechModule | null {
  if (loaded !== undefined) return loaded;
  try {
    loaded = (require('expo-speech-recognition') as typeof import('expo-speech-recognition'))
      .ExpoSpeechRecognitionModule;
  } catch {
    loaded = null;
  }
  return loaded;
}

export function isSpeechRecognitionAvailable(): boolean {
  try {
    return speechModule()?.isRecognitionAvailable() ?? false;
  } catch {
    return false;
  }
}

export async function requestSpeechRecognitionPermission(): Promise<SpeechRecognitionFailure | null> {
  const module = speechModule();
  if (module === null || !isSpeechRecognitionAvailable()) return { code: 'unsupported' };
  try {
    const permission = await module.requestPermissionsAsync();
    return permission.granted ? null : { code: 'not-allowed', detail: permission.status };
  } catch (error: unknown) {
    return { code: 'other', detail: error instanceof Error ? error.message : 'permission request failed' };
  }
}

function failureOf(error: ExpoSpeechRecognitionErrorCode): SpeechRecognitionFailureCode {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'not-allowed';
    case 'audio-capture':
      return 'audio-capture';
    case 'network':
      return 'network';
    case 'language-not-supported':
      return 'language-not-supported';
    case 'no-speech':
    case 'speech-timeout':
      return 'no-speech';
    case 'aborted':
      return 'aborted';
    default:
      return 'other';
  }
}

/** `volumechange` is -2..10, and anything below 0 is inaudible. */
const VOLUME_CEILING = 10;

export function startSpeechRecognition(
  options: SpeechRecognitionOptions,
  handlers: SpeechRecognitionHandlers,
): SpeechRecognitionSession {
  const module = speechModule();
  if (module === null) {
    handlers.onError({ code: 'unsupported' });
    handlers.onEnd();
    return { stop: () => undefined, abort: () => undefined };
  }
  const ExpoSpeechRecognitionModule = module;
  let ended = false;
  /**
   * Finals already delivered. Android's continuous mode starts a new segment
   * after every final result, so the utterance is the settled segments plus
   * whatever is still in flight; iOS only finalizes on stop and always sends
   * the whole transcript, so this stays empty there.
   */
  let settled = '';

  const subscriptions = [
    ExpoSpeechRecognitionModule.addListener('result', (event) => {
      if (ended) return;
      const current = event.results[0]?.transcript ?? '';
      const transcript = `${settled} ${current}`.replace(/\s+/g, ' ').trim();
      if (event.isFinal) settled = transcript;
      handlers.onResult({ transcript, isFinal: event.isFinal });
    }),
    ExpoSpeechRecognitionModule.addListener('error', (event) => {
      if (ended) return;
      const code = failureOf(event.error);
      if (code === 'aborted') return;
      handlers.onError({ code, detail: event.message });
    }),
    ExpoSpeechRecognitionModule.addListener('end', () => finish()),
    ExpoSpeechRecognitionModule.addListener('volumechange', (event) => {
      if (ended) return;
      handlers.onLevel?.(clampLevel(event.value / VOLUME_CEILING));
    }),
  ];

  function finish(): void {
    if (ended) return;
    ended = true;
    for (const subscription of subscriptions) subscription.remove();
    handlers.onLevel?.(0);
    handlers.onEnd();
  }

  try {
    ExpoSpeechRecognitionModule.start({
      lang: options.lang,
      interimResults: true,
      continuous: true,
      addsPunctuation: true,
      maxAlternatives: 1,
      volumeChangeEventOptions: { enabled: handlers.onLevel !== undefined, intervalMillis: 100 },
      ...(options.echoCancellation ? { iosVoiceProcessingEnabled: true } : {}),
    });
  } catch (error: unknown) {
    if (!ended) handlers.onError({ code: 'other', detail: error instanceof Error ? error.message : 'start failed' });
    finish();
  }

  return {
    stop() {
      if (ended) return;
      ExpoSpeechRecognitionModule.stop();
    },
    abort() {
      if (ended) return;
      ExpoSpeechRecognitionModule.abort();
    },
  };
}
