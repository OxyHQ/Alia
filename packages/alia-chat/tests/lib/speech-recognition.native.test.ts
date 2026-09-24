import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: never) => void;

const native = vi.hoisted(() => {
  const listeners = new Map<string, Set<Listener>>();
  return {
    listeners,
    emit(name: string, event: unknown): void {
      for (const listener of listeners.get(name) ?? []) (listener as (event: unknown) => void)(event);
    },
    module: {
      isRecognitionAvailable: vi.fn(() => true),
      requestPermissionsAsync: vi.fn(async () => ({ granted: true, status: 'granted' })),
      start: vi.fn(),
      stop: vi.fn(),
      abort: vi.fn(),
      addListener: vi.fn((name: string, listener: Listener) => {
        const set = listeners.get(name) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(name, set);
        return { remove: () => set.delete(listener) };
      }),
    },
  };
});

/**
 * The file under test loads the native module with `require` on first use (so a
 * binary without it degrades instead of crashing at import), and `vi.mock` only
 * intercepts `import`. The fake goes into the require cache under the path the
 * real package resolves to, which is the path that `require` will look up.
 */
const nodeRequire = createRequire(import.meta.url);
const resolved = nodeRequire.resolve('expo-speech-recognition');
nodeRequire.cache[resolved] = {
  id: resolved,
  filename: resolved,
  loaded: true,
  exports: { ExpoSpeechRecognitionModule: native.module },
} as unknown as NodeJS.Module;

import {
  isSpeechRecognitionAvailable,
  requestSpeechRecognitionPermission,
  startSpeechRecognition,
} from '../../src/lib/speech-recognition.native';

function handlers() {
  return { onResult: vi.fn(), onLevel: vi.fn(), onError: vi.fn(), onEnd: vi.fn() };
}

describe('on-device recognition on iOS and Android', () => {
  beforeEach(() => {
    native.listeners.clear();
    for (const fn of Object.values(native.module)) fn.mockClear();
    native.module.isRecognitionAvailable.mockReturnValue(true);
  });

  it('starts continuous, interim, punctuated recognition in the given language, with echo cancellation on request', () => {
    startSpeechRecognition({ lang: 'es-MX', echoCancellation: true }, handlers());
    expect(native.module.start).toHaveBeenCalledWith(expect.objectContaining({
      lang: 'es-MX',
      continuous: true,
      interimResults: true,
      addsPunctuation: true,
      iosVoiceProcessingEnabled: true,
      volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
    }));
  });

  it('reports the whole utterance, joining the segments Android finalizes one by one', () => {
    const events = handlers();
    startSpeechRecognition({ lang: 'en-US' }, events);
    native.emit('result', { isFinal: true, results: [{ transcript: 'Hello there' }] });
    native.emit('result', { isFinal: false, results: [{ transcript: 'how are' }] });
    expect(events.onResult).toHaveBeenLastCalledWith({ transcript: 'Hello there how are', isFinal: false });
  });

  it('maps the native volume scale onto 0..1', () => {
    const events = handlers();
    startSpeechRecognition({ lang: 'en-US' }, events);
    native.emit('volumechange', { value: 5 });
    native.emit('volumechange', { value: -2 });
    expect(events.onLevel.mock.calls.map(([level]) => level)).toEqual([0.5, 0]);
  });

  it('maps errors, stays quiet about aborts, and ends once — detaching every listener', () => {
    const events = handlers();
    startSpeechRecognition({ lang: 'en-US' }, events);
    native.emit('error', { error: 'aborted', message: '' });
    native.emit('error', { error: 'service-not-allowed', message: 'denied' });
    native.emit('end', null);
    native.emit('end', null);
    expect(events.onError).toHaveBeenCalledTimes(1);
    expect(events.onError).toHaveBeenCalledWith({ code: 'not-allowed', detail: 'denied' });
    expect(events.onEnd).toHaveBeenCalledTimes(1);
    for (const set of native.listeners.values()) expect(set.size).toBe(0);
  });

  it('asks for permission once and reports a refusal', async () => {
    native.module.requestPermissionsAsync.mockResolvedValueOnce({ granted: false, status: 'denied' });
    await expect(requestSpeechRecognitionPermission()).resolves.toEqual({ code: 'not-allowed', detail: 'denied' });
    await expect(requestSpeechRecognitionPermission()).resolves.toBeNull();
  });

  it('says unavailable when the native module is missing from the build', () => {
    native.module.isRecognitionAvailable.mockImplementation(() => {
      throw new Error('Cannot find native module');
    });
    expect(isSpeechRecognitionAvailable()).toBe(false);
  });
});
