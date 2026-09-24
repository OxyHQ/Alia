import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSpeechToText, useSTTStore } from '../../src/hooks/useSpeechToText';

/**
 * Dictation on the web path: the browser's Web Speech API, faked here as a
 * constructor on `globalThis` — which is exactly where Chrome and Safari put
 * it, and where Firefox puts nothing.
 */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((event: { results: unknown }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => queueMicrotask(() => this.onend?.()));
  abort = vi.fn(() => queueMicrotask(() => this.onend?.()));

  constructor() {
    FakeRecognition.instances.push(this);
  }

  /** Deliver results the way the browser does: a list of segments with alternatives. */
  hear(...segments: Array<[string, boolean]>): void {
    const results = segments.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal }));
    this.onresult?.({ results });
  }
}

const media = { getUserMedia: vi.fn() };

let latest: ReturnType<typeof useSpeechToText>;
let renderer: TestRenderer.ReactTestRenderer;
function Harness() {
  latest = useSpeechToText({ lang: 'es-ES' });
  return null;
}

async function mount(): Promise<void> {
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('dictation recognized on the device', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    FakeRecognition.instances = [];
    media.getUserMedia.mockReset();
    media.getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
    vi.stubGlobal('navigator', { language: 'en-US', mediaDevices: media });
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('dictation must not call the network'))));
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    vi.unstubAllGlobals();
  });

  it('listens in the requested language, streams words and hands them back on stop — with no request to Alia', async () => {
    await mount();
    await act(async () => {
      await latest.startRecording();
    });
    await flush();

    expect(latest.isRecording).toBe(true);
    expect(useSTTStore.getState().isRecording).toBe(true);
    const recognition = FakeRecognition.instances[0]!;
    expect(recognition.lang).toBe('es-ES');
    expect(recognition.continuous).toBe(true);
    expect(recognition.interimResults).toBe(true);
    expect(recognition.start).toHaveBeenCalledTimes(1);

    recognition.hear([' Hola', true], [' qué tal', false]);

    let text: string | null = null;
    await act(async () => {
      text = await latest.stopAndTranscribe();
    });
    expect(recognition.stop).toHaveBeenCalledTimes(1);
    expect(text).toBe('Hola qué tal');
    expect(latest.state).toBe('idle');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps listening across the browser ending a session on its own', async () => {
    await mount();
    await act(async () => {
      await latest.startRecording();
    });
    await flush();
    FakeRecognition.instances[0]!.hear(['Primera parte', true]);
    await act(async () => {
      FakeRecognition.instances[0]!.onend?.();
    });
    await flush();

    expect(latest.isRecording).toBe(true);
    expect(FakeRecognition.instances).toHaveLength(2);
    FakeRecognition.instances[1]!.hear(['y segunda', false]);

    let text: string | null = null;
    await act(async () => {
      text = await latest.stopAndTranscribe();
    });
    expect(text).toBe('Primera parte y segunda');
  });

  it('cancel discards what was heard', async () => {
    await mount();
    await act(async () => {
      await latest.startRecording();
    });
    await flush();
    FakeRecognition.instances[0]!.hear(['no enviar esto', false]);
    await act(async () => {
      latest.cancel();
    });
    await flush();
    expect(FakeRecognition.instances[0]!.abort).toHaveBeenCalled();
    expect(latest.state).toBe('idle');
    let text: string | null = 'unset';
    await act(async () => {
      text = await latest.stopAndTranscribe();
    });
    expect(text).toBeNull();
  });

  it('reports a refused microphone and stays idle', async () => {
    media.getUserMedia.mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await mount();
    await act(async () => {
      await latest.startRecording();
    });
    expect(latest.error).toBe('Microphone permission required');
    expect(latest.state).toBe('idle');
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it('says so where the browser cannot recognize speech (Firefox)', async () => {
    vi.stubGlobal('webkitSpeechRecognition', undefined);
    await mount();
    expect(latest.isSupported).toBe(false);
    await act(async () => {
      await latest.startRecording();
    });
    expect(latest.error).toBe('Speech recognition is not available on this device or browser');
    expect(latest.state).toBe('idle');
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });

  it('ends the dictation on a recognizer error instead of restarting into it', async () => {
    await mount();
    await act(async () => {
      await latest.startRecording();
    });
    await flush();
    const recognition = FakeRecognition.instances[0]!;
    await act(async () => {
      recognition.onerror?.({ error: 'network' });
      recognition.onend?.();
    });
    expect(latest.error).toBe('Speech recognition needs a network connection');
    expect(latest.state).toBe('idle');
    expect(FakeRecognition.instances).toHaveLength(1);
  });
});
