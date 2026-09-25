import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Leaving a call that dropped, including a call that started from nothing.
 *
 * `useVoiceMode` auto-deactivates when the room reports `disconnected` while
 * voice is still active — a network drop, an ended session, a server restart.
 * It has to, because nothing else will: the controls stay on screen, the
 * ambient field keeps reacting, and the only honest reading of the UI is that
 * the call is live.
 *
 * The guard it used to carry asked whether `voiceStartIndexRef.current > 0`:
 * how many text messages were on screen when the call started. The intent was
 * right — `disconnected` is also the state a room sits in BEFORE it connects,
 * and firing on that would tear down every call the instant it began — but the
 * question was about the wrong thing. Starting a call from an empty chat is
 * the ordinary way to start one, and it makes that count zero, so those calls
 * were permanently exempt from the teardown.
 *
 * So the two cases here are the two halves of that:
 *
 * - a call from ZERO messages that connects and then drops must deactivate,
 *   which is what the old guard got wrong;
 * - a call that has not connected yet must NOT deactivate, which is what the
 *   old guard existed to prevent and what the new one still has to honour.
 */

const room = vi.hoisted(() => ({
  roomState: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error',
  error: null as string | null,
  errorCode: null as string | null,
  turnError: null as string | null,
  turnErrorCode: null as string | null,
  disconnectCalls: 0,
  connectCalls: 0,
  sendTurn: null as null | ((turn: {
    text: string;
    history: [];
    signal: AbortSignal;
    onText: (text: string) => void;
  }) => Promise<void>),
}));

const toasts = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() }));

vi.mock('@/lib/hooks/use-voice-room', () => ({
  useVoiceRoom: (sendTurn: typeof room.sendTurn) => {
    room.sendTurn = sendTurn;
    return {
      roomState: room.roomState,
      agentState: 'idle',
      error: room.error,
      errorCode: room.errorCode,
      turnError: room.turnError,
      turnErrorCode: room.turnErrorCode,
      messages: [],
      isMuted: false,
      isConnected: room.roomState === 'connected',
      room: null,
      connect: () => { room.connectCalls += 1; },
      disconnect: () => { room.disconnectCalls += 1; },
      toggleMute: vi.fn(),
    };
  },
}));

vi.mock('@alia.onl/sdk/voice', () => ({
  useAudioLevelMonitor: () => ({ captureLevel: 0, playbackLevel: 0 }),
  useAudioLevels: () => ({ waveAmplitude: 0 }),
}));

vi.mock('@oxy.so/bloom/toast', () => ({ toast: toasts }));

// A marker instead of a catalogue: what reaches the toast must be a KEY that
// went through `t`, never a sentence written in the hook.
vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => `t:${key}` }),
}));

import { useVoiceMode } from '@/lib/hooks/use-voice-mode';

type Harness = ReturnType<typeof useVoiceMode>;

const chat = {
  sendMessage: vi.fn(async (..._args: unknown[]) => true),
  stopGeneration: vi.fn(),
};

/** What the conversation screen hands the hook besides the chat: whose call, and whether it is on show. */
interface Scope {
  owner: string;
  isFocused: boolean;
}

/** Mounts the hook over a conversation with no messages at all — the case the old guard missed. */
function mountFromEmptyChat(initial: Scope = { owner: 'user-a:conv-1', isFocused: true }) {
  let api: Harness | null = null;
  let scope = initial;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function Probe(props: Scope) {
    api = useVoiceMode({ sendMessage: chat.sendMessage, stopGeneration: chat.stopGeneration, ...props });
    return null;
  }

  const tree = () =>
    React.createElement(QueryClientProvider, { client }, React.createElement(Probe, scope));

  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(tree());
  });

  return {
    get api() {
      if (!api) throw new Error('hook did not render');
      return api;
    },
    /** Move the room and let the effects that watch it run. */
    setRoomState(next: typeof room.roomState) {
      room.roomState = next;
      act(() => { renderer.update(tree()); });
    },
    /** What the screen around the hook changed: its focus, its conversation, its account. */
    setScope(next: Partial<Scope>) {
      scope = { ...scope, ...next };
      act(() => { renderer.update(tree()); });
    },
    unmount() {
      act(() => { renderer.unmount(); });
    },
  };
}

beforeEach(() => {
  room.roomState = 'disconnected';
  room.error = null;
  room.errorCode = null;
  room.turnError = null;
  room.turnErrorCode = null;
  chat.sendMessage.mockReset();
  chat.sendMessage.mockResolvedValue(true);
  chat.stopGeneration.mockReset();
  toasts.error.mockReset();
  room.disconnectCalls = 0;
  room.connectCalls = 0;
});

describe('useVoiceMode — unexpected disconnection', () => {
  it('ends a call that started from an empty chat and then dropped', () => {
    const harness = mountFromEmptyChat();

    act(() => { harness.api.activateVoice(); });
    expect(harness.api.isVoiceActive).toBe(true);
    expect(room.connectCalls).toBe(1);

    harness.setRoomState('connected');
    expect(harness.api.isVoiceActive).toBe(true);

    harness.setRoomState('disconnected');

    expect(harness.api.isVoiceActive).toBe(false);
    expect(room.disconnectCalls).toBe(1);
  });

  it('leaves a call that has not connected yet alone', () => {
    const harness = mountFromEmptyChat();

    // `activateVoice` asks the room to connect; the room is still reporting
    // `disconnected` on the render right after, which is NOT a dropped call.
    act(() => { harness.api.activateVoice(); });
    harness.setRoomState('disconnected');

    expect(harness.api.isVoiceActive).toBe(true);
    expect(room.disconnectCalls).toBe(0);

    // And the handshake landing is still an ordinary connect, not a teardown.
    harness.setRoomState('connecting');
    harness.setRoomState('connected');

    expect(harness.api.isVoiceActive).toBe(true);
    expect(room.disconnectCalls).toBe(0);
  });
});

describe('useVoiceMode — a call speaks through the conversation', () => {
  it('sends each utterance as an ordinary turn of the conversation, marked as voice, and streams the answer back', async () => {
    mountFromEmptyChat();
    const seen: string[] = [];
    chat.sendMessage.mockImplementation(async (...args: unknown[]) => {
      const options = args[2] as { onAnswerText: (text: string) => void };
      options.onAnswerText('Hola');
      options.onAnswerText('Hola, ¿qué tal?');
      return true;
    });

    await room.sendTurn!({ text: 'Hola Alia', history: [], signal: new AbortController().signal, onText: (text) => seen.push(text) });

    expect(chat.sendMessage).toHaveBeenCalledWith('Hola Alia', undefined, expect.objectContaining({ responseMode: 'voice' }));
    expect(seen).toEqual(['Hola', 'Hola, ¿qué tal?']);
  });

  it('talking over the answer stops the turn streaming', async () => {
    mountFromEmptyChat();
    let finish!: (sent: boolean) => void;
    chat.sendMessage.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const pending = room.sendTurn!({ text: 'Cuéntame', history: [], signal: controller.signal, onText: () => undefined });

    controller.abort();
    expect(chat.stopGeneration).toHaveBeenCalledOnce();
    finish(true);
    await expect(pending).resolves.toBeUndefined();
  });

  it('ends the call when the turn is refused, without repeating what the send already said', async () => {
    const harness = mountFromEmptyChat();
    chat.sendMessage.mockResolvedValue(false);
    const refused = room.sendTurn!({ text: 'Hola', history: [], signal: new AbortController().signal, onText: () => undefined });
    await expect(refused).rejects.toThrow();

    act(() => { harness.api.activateVoice(); });
    room.error = (await refused.catch((error: Error) => error.message)) ?? null;
    harness.setRoomState('error');

    expect(harness.api.isVoiceActive).toBe(false);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('reports a turn that failed without ending the call', () => {
    const harness = mountFromEmptyChat();
    act(() => { harness.api.activateVoice(); });
    harness.setRoomState('connected');
    room.turnError = 'The answer could not be played aloud';
    room.turnErrorCode = 'not-played';
    harness.setRoomState('connected');

    expect(toasts.error).toHaveBeenCalledWith('t:voice.errors.not-played');
    expect(harness.api.isVoiceActive).toBe(true);
  });
});

describe('useVoiceMode — what the person is told, in their language', () => {
  it('says why the call could not start with the translated reason', () => {
    const harness = mountFromEmptyChat();
    act(() => { harness.api.activateVoice(); });
    room.error = 'Microphone permission required';
    room.errorCode = 'microphone-denied';
    harness.setRoomState('error');

    expect(toasts.error).toHaveBeenCalledWith('t:voice.errors.microphone-denied');
    expect(harness.api.isVoiceActive).toBe(false);
  });

  it('says the connection failed, translated, when the room fails without a reason', () => {
    const harness = mountFromEmptyChat();
    act(() => { harness.api.activateVoice(); });
    harness.setRoomState('error');

    expect(toasts.error).toHaveBeenCalledWith('t:voice.connectionFailed');
    expect(harness.api.isVoiceActive).toBe(false);
  });
});

/**
 * A call belongs to one conversation of one account, on the screen showing it.
 *
 * The native stack keeps a screen mounted under the one pushed over it, so a
 * call left running there would go on capturing the microphone behind a screen
 * with no controls to end it — and a screen whose conversation changes in place
 * would carry the call into a thread it was not started in. Each case below
 * ends the call the way the person's own "end" does: the room is disconnected,
 * which is what releases the recognizer and the microphone (the SDK's
 * `disconnect`, pinned in `useVoiceRoom.test.tsx`).
 */
describe('useVoiceMode — navigation and account switches end the call', () => {
  function liveCall() {
    const harness = mountFromEmptyChat();
    act(() => { harness.api.activateVoice(); });
    harness.setRoomState('connected');
    expect(harness.api.isVoiceActive).toBe(true);
    return harness;
  }

  it('ends the call when another route covers its screen', () => {
    const harness = liveCall();
    harness.setScope({ isFocused: false });

    expect(harness.api.isVoiceActive).toBe(false);
    expect(room.disconnectCalls).toBe(1);
  });

  it('ends the call when the screen moves to another conversation', () => {
    const harness = liveCall();
    harness.setScope({ owner: 'user-a:conv-2' });

    expect(harness.api.isVoiceActive).toBe(false);
    expect(room.disconnectCalls).toBe(1);
  });

  it('ends the call when the account switches', () => {
    const harness = liveCall();
    harness.setScope({ owner: 'user-b:conv-1' });

    expect(harness.api.isVoiceActive).toBe(false);
    expect(room.disconnectCalls).toBe(1);
  });

  it('keeps a call whose screen, conversation and account are unchanged', () => {
    const harness = liveCall();
    harness.setScope({ owner: 'user-a:conv-1', isFocused: true });

    expect(harness.api.isVoiceActive).toBe(true);
    expect(room.disconnectCalls).toBe(0);
  });

  it('does not start a call from a screen that is not on show', () => {
    const harness = mountFromEmptyChat({ owner: 'user-a:conv-1', isFocused: false });
    act(() => { harness.api.activateVoice(); });

    expect(harness.api.isVoiceActive).toBe(false);
    expect(room.connectCalls).toBe(0);
  });

  it('a call started after coming back is the new owner\'s, and the next change still ends it', () => {
    const harness = liveCall();
    harness.setScope({ owner: 'user-a:conv-2' });
    expect(harness.api.isVoiceActive).toBe(false);

    room.roomState = 'disconnected';
    act(() => { harness.api.activateVoice(); });
    harness.setRoomState('connected');
    expect(harness.api.isVoiceActive).toBe(true);

    harness.setScope({ isFocused: false });
    expect(harness.api.isVoiceActive).toBe(false);
    expect(room.disconnectCalls).toBe(2);
  });
});
