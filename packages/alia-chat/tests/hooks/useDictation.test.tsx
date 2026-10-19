import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Dictation with a fake recorder (no microphone) and a fake `fetch` (no Alia):
 * the states, the text, the typed failures, the five-minute stop and the one
 * retry are the real hook's.
 */
const fx = vi.hoisted(() => ({
  token: 'session-token' as string | null,
  startFailure: null as null | { code: 'mic-denied' | 'mic-unavailable' },
  clipMs: 4_000,
  onLevel: null as null | ((level: number) => void),
  started: 0,
  stopped: 0,
  cancelled: 0,
}));

vi.mock('@oxy.so/services/ui/client', () => ({
  // The host's app assertion (ADR 0021): none here (`tests/support/app-assertion-host.ts`).
  useAppAssertion: () => ({
    getAppAssertion: async () => null,
    getAppAssertionHeaders: async () => ({}),
  }),
  useOxy: () => ({
    oxyServices: {
      session: {
        get accessToken() {
          return fx.token;
        },
      },
    },
  }),
}));

vi.mock('../../src/lib/dictation-recorder', async () => {
  const types = await import('../../src/lib/dictation-recorder-types');
  const recorder = {
    async start(onLevel: (level: number) => void) {
      fx.started += 1;
      if (fx.startFailure) throw new types.DictationRecorderError(fx.startFailure.code);
      fx.onLevel = onLevel;
    },
    async stop() {
      fx.stopped += 1;
      return {
        file: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
        mediaType: 'audio/webm',
        durationMs: fx.clipMs,
      };
    },
    cancel() {
      fx.cancelled += 1;
    },
  };
  return { ...types, useDictationRecorder: () => recorder };
});

import { useDictation, useDictationStore } from '../../src/hooks/useDictation';

let latest: ReturnType<typeof useDictation>;
let renderer: TestRenderer.ReactTestRenderer | undefined;
let texts: string[];

async function mount(): Promise<void> {
  function Harness() {
    latest = useDictation({
      lang: 'es-ES',
      apiUrl: 'https://api.alia.test',
      onText: (t) => texts.push(t),
    });
    return null;
  }
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
}

function respond(...answers: Array<{ status: number; body: unknown }>) {
  const fetchMock = vi.fn(async () => {
    const next = answers.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  fx.token = 'session-token';
  fx.startFailure = null;
  fx.clipMs = 4_000;
  fx.onLevel = null;
  fx.started = 0;
  fx.stopped = 0;
  fx.cancelled = 0;
  texts = [];
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useDictation', () => {
  it('records, then inserts the transcription once', async () => {
    const fetchMock = respond({ status: 200, body: { text: ' hola mundo ' } });
    await mount();
    await act(async () => latest.start());
    expect(latest.state).toBe('recording');
    expect(useDictationStore.getState().isRecording).toBe(true);
    act(() => fx.onLevel?.(0.6));
    expect(useDictationStore.getState().metering).toBe(0.6);

    let text: string | null = null;
    await act(async () => {
      text = await latest.stop();
    });
    expect(text).toBe('hola mundo');
    expect(texts).toEqual(['hola mundo']);
    expect(latest.state).toBe('idle');
    expect(useDictationStore.getState().isRecording).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('says the microphone was refused, and never asks Alia', async () => {
    const fetchMock = respond();
    fx.startFailure = { code: 'mic-denied' };
    await mount();
    await act(async () => latest.start());
    expect(latest.state).toBe('error');
    expect(latest.errorCode).toBe('mic-denied');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('inserts nothing when the transcription fails, and keeps the clip for ONE retry', async () => {
    const fetchMock = respond(
      { status: 503, body: { error: { code: 'TRANSCRIPTION_UNAVAILABLE', message: 'x' } } },
      { status: 502, body: { error: { code: 'TRANSCRIPTION_FAILED', message: 'x' } } },
    );
    await mount();
    await act(async () => latest.start());
    await act(async () => {
      await latest.stop();
    });
    expect(latest.errorCode).toBe('transcription-unavailable');
    expect(latest.canRetry).toBe(true);
    expect(texts).toEqual([]);

    await act(async () => {
      await latest.retry();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The same clip went up again, without recording again.
    expect(fx.started).toBe(1);
    expect(latest.errorCode).toBe('transcription-failed');
    expect(latest.canRetry).toBe(false);
    expect(texts).toEqual([]);

    await act(async () => {
      await latest.retry();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a retry that succeeds inserts the text', async () => {
    respond(
      { status: 429, body: { error: { code: 'TRANSCRIPTION_LIMITED', message: 'x' } } },
      { status: 200, body: { text: 'segunda vez' } },
    );
    await mount();
    await act(async () => latest.start());
    await act(async () => {
      await latest.stop();
    });
    expect(latest.errorCode).toBe('transcription-limited');
    await act(async () => {
      await latest.retry();
    });
    expect(texts).toEqual(['segunda vez']);
    expect(latest.state).toBe('idle');
  });

  it('refuses a clip over five minutes as too-long without sending it', async () => {
    const fetchMock = respond();
    fx.clipMs = 5 * 60_000 + 5_000;
    await mount();
    await act(async () => latest.start());
    await act(async () => {
      await latest.stop();
    });
    expect(latest.errorCode).toBe('too-long');
    expect(latest.canRetry).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops by itself at five minutes, showing the time left in the last 30 seconds', async () => {
    vi.useFakeTimers();
    respond({ status: 200, body: { text: 'largo' } });
    await mount();
    await act(async () => latest.start());
    await act(async () => {
      vi.advanceTimersByTime(4 * 60_000);
    });
    expect(latest.remainingMs).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(40_000);
    });
    expect(latest.remainingMs).not.toBeNull();
    expect(latest.remainingMs!).toBeLessThanOrEqual(30_000);
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    vi.useRealTimers();
    await vi.waitFor(() => expect(texts).toEqual(['largo']));
    expect(fx.stopped).toBe(1);
  });

  it('is not-authenticated without a session', async () => {
    const fetchMock = respond();
    fx.token = null;
    await mount();
    await act(async () => latest.start());
    await act(async () => {
      await latest.stop();
    });
    expect(latest.errorCode).toBe('not-authenticated');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancel throws the recording away', async () => {
    const fetchMock = respond();
    await mount();
    await act(async () => latest.start());
    act(() => latest.cancel());
    expect(fx.cancelled).toBe(1);
    expect(latest.state).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('releases the microphone and the store when the composer unmounts mid-recording', async () => {
    respond();
    await mount();
    await act(async () => latest.start());
    act(() => renderer?.unmount());
    renderer = undefined;
    expect(fx.cancelled).toBe(1);
    expect(useDictationStore.getState().isRecording).toBe(false);
  });
});
