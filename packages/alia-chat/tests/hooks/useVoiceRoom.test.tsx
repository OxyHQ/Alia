import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechRecognitionHandlers, SpeechRecognitionOptions } from '../../src/lib/speech-recognition-types';
import type { VoiceTurn, VoiceTurnSender } from '../../src/lib/voice-turn';

/**
 * The voice loop, with its three edges replaced: the recognizer (sessions the
 * test drives by hand), speech synthesis and clip playback. The loop itself —
 * end of utterance, the turn, sentence-by-sentence speech, barge-in, mute — is
 * the real code.
 */
interface FakeSession {
  readonly options: SpeechRecognitionOptions;
  readonly handlers: SpeechRecognitionHandlers;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly abort: ReturnType<typeof vi.fn>;
  ended: boolean;
}

interface Playback {
  readonly uri: string;
  readonly signal: AbortSignal;
  finish(): void;
}

const fx = vi.hoisted(() => ({
  available: true,
  refusal: null as null | { code: string },
  sessions: [] as FakeSession[],
  clips: [] as Array<{ input: string; voice: string; model: string; signal: AbortSignal }>,
  playbacks: [] as Playback[],
}));

vi.mock('@oxy.so/services', () => ({
  useOxy: () => ({ oxyServices: { httpService: { getAccessToken: () => 'session-token' }, createLinkedClient: vi.fn() } }),
}));

vi.mock('../../src/lib/speech-recognition', () => ({
  isSpeechRecognitionAvailable: () => fx.available,
  requestSpeechRecognitionPermission: async () => fx.refusal,
  startSpeechRecognition: (options: SpeechRecognitionOptions, handlers: SpeechRecognitionHandlers) => {
    const session: FakeSession = {
      options,
      handlers,
      ended: false,
      stop: vi.fn(() => end(session)),
      abort: vi.fn(() => end(session)),
    };
    fx.sessions.push(session);
    return session;
  },
}));

function end(session: FakeSession): void {
  queueMicrotask(() => {
    if (session.ended) return;
    session.ended = true;
    session.handlers.onEnd();
  });
}

vi.mock('../../src/lib/speech-synthesis', () => ({
  requestSpeechClip: vi.fn(async (request: { input: string; voice: string; model: string; signal: AbortSignal }) => {
    fx.clips.push(request);
    return `clip:${request.input}`;
  }),
  playSpeechClip: vi.fn((uri: string, options: { signal: AbortSignal }) => new Promise<void>((resolve) => {
    fx.playbacks.push({ uri, signal: options.signal, finish: resolve });
    options.signal.addEventListener('abort', () => resolve(), { once: true });
  })),
}));

import { useVoiceRoom } from '../../src/hooks/useVoiceRoom';

let latest: ReturnType<typeof useVoiceRoom>;
let renderer: TestRenderer.ReactTestRenderer | undefined;

/** A sender the test answers by hand, recording every turn it was given. */
function controllableSender() {
  const turns: Array<VoiceTurn & { resolve(): void; reject(error: Error): void }> = [];
  const send: VoiceTurnSender = (turn) => new Promise<void>((resolve, reject) => {
    turns.push({ ...turn, resolve, reject });
  });
  return { send, turns };
}

async function mount(options: Parameters<typeof useVoiceRoom>[0]): Promise<void> {
  function Harness() {
    latest = useVoiceRoom(options);
    return null;
  }
  await act(async () => {
    renderer = TestRenderer.create(<Harness />);
  });
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const liveSession = (): FakeSession => {
  const session = [...fx.sessions].reverse().find((candidate) => !candidate.ended);
  if (session === undefined) throw new Error('no live recognition session');
  return session;
};

async function say(text: string): Promise<void> {
  await act(async () => {
    liveSession().handlers.onResult({ transcript: text, isFinal: false });
  });
}

describe('the on-device voice loop', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fx.available = true;
    fx.refusal = null;
    fx.sessions = [];
    fx.clips = [];
    fx.playbacks = [];
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('listens, sends the utterance through the chat sender, and speaks the answer sentence by sentence in the product voice', async () => {
    const sender = controllableSender();
    await mount({ sendTurn: sender.send, endOfUtteranceMs: 5, voicePreference: 'male', lang: 'es-ES' });

    await act(async () => latest.connect());
    expect(latest.roomState).toBe('connected');
    expect(latest.agentState).toBe('listening');
    expect(fx.sessions[0]?.options).toEqual({ lang: 'es-ES', echoCancellation: true });

    await say('¿Qué tiempo hace');
    await say('¿Qué tiempo hace en Madrid?');
    expect(latest.messages).toMatchObject([{ role: 'user', content: '¿Qué tiempo hace en Madrid?', isStreaming: true }]);

    await settle(20); // silence → end of utterance → stop → final
    expect(fx.sessions[0]?.stop).toHaveBeenCalledTimes(1);
    expect(sender.turns).toHaveLength(1);
    expect(sender.turns[0]?.text).toBe('¿Qué tiempo hace en Madrid?');
    expect(sender.turns[0]?.history).toEqual([]);
    expect(latest.agentState).toBe('thinking');

    // The first sentence is spoken while the rest is still streaming.
    await act(async () => sender.turns[0]!.onText('Hace sol. Mañana'));
    await settle();
    expect(fx.clips.map((clip) => clip.input)).toEqual(['Hace sol.']);
    expect(fx.clips[0]).toMatchObject({ voice: 'male', model: 'route:voice' });
    expect(fx.playbacks.map((playback) => playback.uri)).toEqual(['clip:Hace sol.']);
    expect(latest.agentState).toBe('speaking');

    await act(async () => {
      sender.turns[0]!.onText('Hace sol. Mañana lloverá.');
      sender.turns[0]!.resolve();
    });
    await settle();
    expect(latest.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Hace sol. Mañana lloverá.', isStreaming: false });

    await act(async () => fx.playbacks[0]!.finish());
    await settle();
    expect(fx.playbacks.map((playback) => playback.uri)).toEqual(['clip:Hace sol.', 'clip:Mañana lloverá.']);
    await act(async () => fx.playbacks[1]!.finish());
    await settle();
    expect(latest.agentState).toBe('listening');
    expect(latest.turnError).toBeNull();

    // The next turn carries this one as history.
    await say('Gracias');
    await settle(20);
    expect(sender.turns[1]?.history).toEqual([
      { role: 'user', content: '¿Qué tiempo hace en Madrid?' },
      { role: 'assistant', content: 'Hace sol. Mañana lloverá.' },
    ]);
  });

  it('lets the person talk over the answer: playback and the chat request stop, and their words become the next turn', async () => {
    const sender = controllableSender();
    await mount({ sendTurn: sender.send, endOfUtteranceMs: 5 });
    await act(async () => latest.connect());
    await say('Cuéntame un cuento');
    await settle(20);
    await act(async () => sender.turns[0]!.onText('Había una vez un dragón muy grande. '));
    await settle();
    expect(latest.agentState).toBe('speaking');
    const playback = fx.playbacks[0]!;

    // The answer coming back through the speaker is not an interruption…
    await say('había una vez un dragón');
    expect(playback.signal.aborted).toBe(false);

    // …the person saying something new is.
    await say('había una vez espera para');
    expect(playback.signal.aborted).toBe(true);
    expect(sender.turns[0]!.signal.aborted).toBe(true);
    expect(latest.agentState).toBe('listening');
    expect(latest.messages.at(-1)).toMatchObject({ role: 'user', content: 'espera para', isStreaming: true });
    expect(latest.messages.at(-2)).toMatchObject({ role: 'assistant', isStreaming: false });

    await settle(20);
    expect(sender.turns[1]?.text).toBe('espera para');
  });

  it('does not cut the answer off when barge-in is disabled', async () => {
    const sender = controllableSender();
    await mount({ sendTurn: sender.send, endOfUtteranceMs: 5, bargeIn: false });
    await act(async () => latest.connect());
    await say('Hola');
    await settle(20);
    await say('espera espera para');
    expect(sender.turns[0]!.signal.aborted).toBe(false);
  });

  it('mute drops the half-said utterance and stops listening until unmuted', async () => {
    const sender = controllableSender();
    await mount({ sendTurn: sender.send, endOfUtteranceMs: 5 });
    await act(async () => latest.connect());
    await say('esto no');
    await act(async () => latest.toggleMute());
    await settle(20);
    expect(latest.isMuted).toBe(true);
    expect(latest.messages).toEqual([]);
    expect(sender.turns).toHaveLength(0);
    expect(fx.sessions.filter((session) => !session.ended)).toHaveLength(0);

    await act(async () => latest.toggleMute());
    expect(fx.sessions.filter((session) => !session.ended)).toHaveLength(1);
  });

  it('reports a turn with no answer without ending the call', async () => {
    const sender = controllableSender();
    await mount({ sendTurn: sender.send, endOfUtteranceMs: 5 });
    await act(async () => latest.connect());
    await say('Hola');
    await settle(20);
    await act(async () => sender.turns[0]!.resolve());
    await settle();
    expect(latest.turnError).toBe('No answer came back — try saying it again');
    expect(latest.turnErrorCode).toBe('no-answer');
    expect(latest.roomState).toBe('connected');
    expect(latest.agentState).toBe('listening');
    expect(latest.messages).toMatchObject([{ role: 'user', content: 'Hola' }]);
  });

  it('ends the call with the reason when a turn cannot be sent', async () => {
    const sender = controllableSender();
    await mount({ sendTurn: sender.send, endOfUtteranceMs: 5 });
    await act(async () => latest.connect());
    await say('Hola');
    await settle(20);
    await act(async () => sender.turns[0]!.reject(new Error("You've run out of credits.")));
    await settle();
    expect(latest.error).toBe("You've run out of credits.");
    expect(latest.errorCode).toBe('turn-failed');
    expect(latest.roomState).toBe('error');
  });

  it('refuses to start without the microphone, or where recognition does not exist', async () => {
    fx.refusal = { code: 'not-allowed' };
    await mount({ sendTurn: controllableSender().send });
    await act(async () => latest.connect());
    expect(latest.roomState).toBe('error');
    expect(latest.error).toBe('Microphone permission required');
    expect(latest.errorCode).toBe('microphone-denied');
    expect(fx.sessions).toHaveLength(0);

    fx.refusal = null;
    fx.available = false;
    await act(async () => latest.connect());
    expect(latest.error).toBe('Voice is not available on this device');
    expect(latest.errorCode).toBe('voice-unavailable');
  });

  it('ends the call when the recognizer loses the microphone mid-call', async () => {
    await mount({ sendTurn: controllableSender().send });
    await act(async () => latest.connect());
    await act(async () => {
      const session = liveSession();
      session.handlers.onError({ code: 'audio-capture', detail: 'NotFoundError' });
      session.ended = true;
      session.handlers.onEnd();
    });
    expect(latest.roomState).toBe('error');
    expect(latest.error).toBe('No microphone found — check your input devices');
    expect(latest.errorCode).toBe('microphone-missing');
  });

  it('disconnect stops everything and clears the transcript', async () => {
    const sender = controllableSender();
    await mount({ sendTurn: sender.send, endOfUtteranceMs: 5 });
    await act(async () => latest.connect());
    await say('Hola');
    await settle(20);
    await act(async () => latest.disconnect());
    expect(sender.turns[0]!.signal.aborted).toBe(true);
    expect(latest.roomState).toBe('disconnected');
    expect(latest.agentState).toBe('idle');
    expect(latest.messages).toEqual([]);
  });
});
