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
  turnError: null as string | null,
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
      turnError: room.turnError,
      messages: [],
      isMuted: false,
      cohostActive: false,
      currentSpeaker: null,
      roundComplete: false,
      isConnected: room.roomState === 'connected',
      room: null,
      connect: () => { room.connectCalls += 1; },
      disconnect: () => { room.disconnectCalls += 1; },
      toggleMute: vi.fn(),
      enableCohost: vi.fn(),
      disableCohost: vi.fn(),
      continueCohost: vi.fn(),
    };
  },
}));

vi.mock('@alia.onl/sdk/voice', () => ({
  useAudioLevelMonitor: () => ({ captureLevel: 0, playbackLevel: 0 }),
  useAudioLevels: () => ({ waveAmplitude: 0 }),
}));

vi.mock('@oxy.so/bloom/toast', () => ({ toast: toasts }));

import { useVoiceMode } from '@/lib/hooks/use-voice-mode';

type Harness = ReturnType<typeof useVoiceMode>;

const chat = {
  sendMessage: vi.fn(async (..._args: unknown[]) => true),
  stopGeneration: vi.fn(),
};

/** Mounts the hook over a conversation with no messages at all — the case the old guard missed. */
function mountFromEmptyChat() {
  let api: Harness | null = null;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function Probe() {
    api = useVoiceMode({ sendMessage: chat.sendMessage, stopGeneration: chat.stopGeneration });
    return null;
  }

  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(
      React.createElement(QueryClientProvider, { client }, React.createElement(Probe)),
    );
  });

  return {
    get api() {
      if (!api) throw new Error('hook did not render');
      return api;
    },
    /** Move the room and let the effects that watch it run. */
    setRoomState(next: typeof room.roomState) {
      room.roomState = next;
      act(() => { renderer.update(
        React.createElement(QueryClientProvider, { client }, React.createElement(Probe)),
      ); });
    },
  };
}

beforeEach(() => {
  room.roomState = 'disconnected';
  room.error = null;
  room.turnError = null;
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
    harness.setRoomState('connected');

    expect(toasts.error).toHaveBeenCalledWith('The answer could not be played aloud');
    expect(harness.api.isVoiceActive).toBe(true);
  });
});
