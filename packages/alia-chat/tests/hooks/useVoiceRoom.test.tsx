import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEngine, FakeSocket } from '../support/fake-voice';

/**
 * The hook over a call with fake audio and a fake socket: the projections the
 * bar, the wave and the app read, and the lifecycle (connect, hang up,
 * unmount). The call itself is `tests/lib/voice-call.test.ts`.
 */
const fx = vi.hoisted(() => ({ token: 'session-token' as string | null }));

vi.mock('@oxy.so/services/ui/client', async () => ({
  ...(await import('../support/app-assertion-host')).hostWithoutAppAssertion,
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

import { useVoiceRoom } from '../../src/hooks/useVoiceRoom';

let latest: ReturnType<typeof useVoiceRoom>;
let renderer: TestRenderer.ReactTestRenderer | undefined;
let sockets: FakeSocket[];
let engine: FakeEngine;
let saved: string[][];

async function mount(): Promise<void> {
  function Harness() {
    latest = useVoiceRoom({
      apiUrl: 'https://api.alia.test',
      conversationId: 'conv-9',
      voicePreference: 'male',
      lang: 'en-US',
      onMessagesSaved: (_conversation, ids) => saved.push([...ids]),
      createAudioEngine: () => engine,
      openSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    return null;
  }
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
}

const socket = () => sockets.at(-1)!;

async function goLive(): Promise<void> {
  await act(async () => {
    await latest.connect();
  });
  act(() => {
    socket().open();
    socket().receive({ type: 'auth.ok' });
    socket().receive({ type: 'session.accepted', voiceSessionId: 'vs', callId: 'c', seq: 0 });
    socket().receive({
      type: 'session.ready',
      model: { id: 'x/realtime', displayName: 'Realtime', publisher: 'X' },
      maxDurationMs: 1,
      idleTimeoutMs: 1,
      resumeWindowMs: 30_000,
      seq: 1,
    });
    engine.capture();
    socket().receive({ type: 'input.ready', seq: 2 });
  });
}

beforeEach(() => {
  fx.token = 'session-token';
  sockets = [];
  engine = new FakeEngine();
  saved = [];
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('useVoiceRoom', () => {
  it('starts disconnected and idle', async () => {
    await mount();
    expect(latest.roomState).toBe('disconnected');
    expect(latest.agentState).toBe('idle');
    expect(latest.callState).toEqual({ kind: 'idle' });
  });

  it('is connecting until it can prove it listens, then connected and listening', async () => {
    await mount();
    await act(async () => {
      await latest.connect();
    });
    expect(latest.roomState).toBe('connecting');
    expect(latest.isConnected).toBe(false);
    // The auth frame waits for the host's app assertion (none here, ADR 0021).
    await act(async () => {
      socket().open();
      await Promise.resolve();
    });
    expect(socket().events()[0]).toEqual({ type: 'auth', token: expect.any(String) });
    act(() => {
      socket().receive({ type: 'auth.ok' });
    });
    expect(socket().events()[1]).toMatchObject({
      type: 'session.start',
      conversationId: 'conv-9',
      voice: 'male',
      locale: 'en-US',
    });
    act(() => {
      socket().receive({ type: 'session.accepted', voiceSessionId: 'vs', callId: 'c', seq: 0 });
    });
    expect(latest.roomState).toBe('connecting');
    await goLiveRest();
    expect(latest.roomState).toBe('connected');
    expect(latest.agentState).toBe('listening');
    expect(latest.model?.displayName).toBe('Realtime');
  });

  it('projects speaking and a tool onto the coarse states', async () => {
    await mount();
    await goLive();
    act(() => {
      socket().receive({ type: 'user.speech_stopped', itemId: 'u', seq: 3 });
      socket().receive({
        type: 'tool.started',
        messageId: 'voice-turn-1',
        callId: 't',
        name: 'webSearch',
        seq: 4,
      });
    });
    expect(latest.callState).toEqual({ kind: 'using-tool', tool: 'webSearch' });
    expect(latest.agentState).toBe('thinking');
    act(() => {
      socket().receive({
        type: 'tool.finished',
        messageId: 'voice-turn-1',
        callId: 't',
        name: 'webSearch',
        ok: true,
        seq: 5,
      });
      socket().receiveAudio('a', new Uint8Array(960));
      engine.play('a');
    });
    expect(latest.agentState).toBe('speaking');
    expect(latest.currentSpeaker).toBe('primary');
  });

  it('reports reconnecting as its own room state', async () => {
    await mount();
    await goLive();
    act(() => socket().receive({ type: 'session.reconnecting', seq: 3 }));
    expect(latest.roomState).toBe('reconnecting');
    expect(latest.isConnected).toBe(false);
  });

  it('exposes a call moved elsewhere as an ending reason, never as an error', async () => {
    await mount();
    await goLive();
    act(() => socket().receive({ type: 'session.closed', reason: 'call-moved-elsewhere', seq: 3 }));
    expect(latest.endedReason).toBe('call-moved-elsewhere');
    expect(latest.error).toBeNull();
    expect(latest.errorCode).toBeNull();
    expect(latest.roomState).toBe('disconnected');
  });

  it('exposes a typed failure with its English sentence', async () => {
    await mount();
    await goLive();
    act(() => {
      socket().receive({
        type: 'error',
        code: 'realtime-limited',
        message: 'x',
        retryable: true,
        reference: 'r',
        seq: 3,
      });
      socket().receive({ type: 'session.closed', reason: 'error', seq: 4 });
    });
    expect(latest.roomState).toBe('error');
    expect(latest.errorCode).toBe('realtime-limited');
    expect(latest.error).toMatch(/limit/);
  });

  it('passes stored message ids to the host', async () => {
    await mount();
    await goLive();
    act(() =>
      socket().receive({
        type: 'messages.saved',
        conversationId: 'conv-9',
        messageIds: ['m'],
        seq: 3,
      }),
    );
    expect(saved).toEqual([['m']]);
  });

  it('hangs up on disconnect and on unmount', async () => {
    await mount();
    await goLive();
    act(() => latest.disconnect());
    expect(sockets[0]!.events().at(-1)).toEqual({ type: 'session.end' });
    expect(latest.roomState).toBe('disconnected');
    expect(engine.stopped).toBe(true);

    engine = new FakeEngine();
    await goLive();
    act(() => renderer?.unmount());
    renderer = undefined;
    expect(sockets[1]!.events().at(-1)).toEqual({ type: 'session.end' });
    expect(engine.stopped).toBe(true);
  });

  it('mutes by sending no audio', async () => {
    await mount();
    await goLive();
    const sent = socket().audio().length;
    act(() => latest.toggleMute());
    expect(latest.isMuted).toBe(true);
    act(() => engine.capture());
    expect(socket().audio()).toHaveLength(sent);
  });

  it('fails as not-authenticated without a session token', async () => {
    fx.token = null;
    await mount();
    await act(async () => {
      await latest.connect();
    });
    expect(latest.errorCode).toBe('not-authenticated');
    expect(sockets).toHaveLength(0);
  });
});

async function goLiveRest(): Promise<void> {
  act(() => {
    socket().receive({
      type: 'session.ready',
      model: { id: 'x/realtime', displayName: 'Realtime', publisher: 'X' },
      maxDurationMs: 1,
      idleTimeoutMs: 1,
      resumeWindowMs: 30_000,
      seq: 1,
    });
  });
  expect(latest.roomState).toBe('connecting');
  act(() => engine.capture());
  expect(latest.roomState).toBe('connecting');
  act(() => socket().receive({ type: 'input.ready', seq: 2 }));
}
