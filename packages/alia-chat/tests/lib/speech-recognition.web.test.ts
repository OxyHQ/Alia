import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechRecognitionHandlers } from '../../src/lib/speech-recognition-types';

/**
 * The web engine against a fake `webkitSpeechRecognition` that behaves as
 * Chrome's does where it matters: ONE microphone recognition per browser, and
 * starting one aborts whichever was live (`SpeechRecognitionManagerImpl::
 * StartSession`). The owner's report reproduced in the console of alia.onl as
 * `start` → `error: aborted` → `end` with nobody calling `abort()`: another
 * recognition had taken the recognizer.
 *
 * No `navigator.mediaDevices` here, so no level meter: the recognizer alone.
 */
class FakeChromeRecognition {
  static live: FakeChromeRecognition | null = null;
  static instances: FakeChromeRecognition[] = [];
  static running = 0;
  static mostRunning = 0;

  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  private active = false;

  constructor() {
    FakeChromeRecognition.instances.push(this);
  }

  start(): void {
    // "If there is another session using the microphone, abort that."
    FakeChromeRecognition.live?.end('aborted');
    FakeChromeRecognition.live = this;
    this.active = true;
    FakeChromeRecognition.running += 1;
    FakeChromeRecognition.mostRunning = Math.max(
      FakeChromeRecognition.mostRunning,
      FakeChromeRecognition.running,
    );
    queueMicrotask(() => {
      if (this.active) this.onstart?.();
    });
  }

  stop(): void {
    this.end(null);
  }

  abort(): void {
    this.end('aborted');
  }

  end(error: string | null): void {
    if (!this.active) return;
    this.active = false;
    FakeChromeRecognition.running -= 1;
    if (FakeChromeRecognition.live === this) FakeChromeRecognition.live = null;
    queueMicrotask(() => {
      if (error !== null) this.onerror?.({ error });
      this.onend?.();
    });
  }
}

function handlers() {
  return {
    onStart: vi.fn(),
    onResult: vi.fn(),
    onError: vi.fn(),
    onEnd: vi.fn(),
  } satisfies SpeechRecognitionHandlers;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the web engine', () => {
  beforeEach(() => {
    FakeChromeRecognition.live = null;
    FakeChromeRecognition.instances = [];
    FakeChromeRecognition.running = 0;
    FakeChromeRecognition.mostRunning = 0;
    vi.stubGlobal('webkitSpeechRecognition', FakeChromeRecognition);
    vi.stubGlobal('navigator', {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function engine() {
    return import('../../src/lib/speech-recognition');
  }

  it('says when the browser has started listening', async () => {
    const { startSpeechRecognition } = await engine();
    const events = handlers();
    startSpeechRecognition({ lang: 'es-ES' }, events);
    expect(events.onStart).not.toHaveBeenCalled();
    await flush();
    expect(events.onStart).toHaveBeenCalledTimes(1);
    expect(FakeChromeRecognition.instances[0]).toMatchObject({
      lang: 'es-ES',
      continuous: true,
      interimResults: true,
    });
  });

  it('reports an abort nobody here asked for — another recognition took the recognizer', async () => {
    const { startSpeechRecognition } = await engine();
    const events = handlers();
    startSpeechRecognition({ lang: 'es-ES' }, events);
    await flush();

    // Another tab starts its own recognition: Chrome aborts ours.
    new FakeChromeRecognition().start();
    await flush();
    expect(events.onError).toHaveBeenCalledWith({ code: 'interrupted', detail: 'aborted' });
    expect(events.onEnd).toHaveBeenCalledTimes(1);
  });

  it('stays quiet about the aborts it asked for', async () => {
    const { startSpeechRecognition } = await engine();
    const events = handlers();
    const session = startSpeechRecognition({ lang: 'es-ES' }, events);
    await flush();
    session.abort();
    await flush();
    expect(events.onError).not.toHaveBeenCalled();
    expect(events.onEnd).toHaveBeenCalledTimes(1);
  });

  it('never runs two of its own sessions at once: a new one ends the last before it starts', async () => {
    const { startSpeechRecognition } = await engine();
    const first = handlers();
    const second = handlers();
    const order: string[] = [];
    first.onEnd.mockImplementation(() => order.push('first ended'));
    second.onStart.mockImplementation(() => order.push('second started'));

    startSpeechRecognition({ lang: 'es-ES' }, first);
    await flush();
    startSpeechRecognition({ lang: 'es-ES' }, second);
    await flush();
    await flush();

    expect(order).toEqual(['first ended', 'second started']);
    // The page took its own session down: that abort was asked for, so it is no error.
    expect(first.onError).not.toHaveBeenCalled();
    expect(second.onError).not.toHaveBeenCalled();
    expect(FakeChromeRecognition.mostRunning).toBe(1);
  });

  it('reports a recognizer that refuses to start, and ends', async () => {
    const { startSpeechRecognition } = await engine();
    vi.spyOn(FakeChromeRecognition.prototype, 'start').mockImplementation(() => {
      throw Object.assign(new Error('already started'), { name: 'InvalidStateError' });
    });
    const events = handlers();
    startSpeechRecognition({ lang: 'es-ES' }, events);
    await flush();
    expect(events.onStart).not.toHaveBeenCalled();
    expect(events.onError).toHaveBeenCalledWith({ code: 'other', detail: 'InvalidStateError' });
    expect(events.onEnd).toHaveBeenCalledTimes(1);
  });
});
