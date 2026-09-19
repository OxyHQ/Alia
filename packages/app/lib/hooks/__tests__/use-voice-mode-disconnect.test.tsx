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
  disconnectCalls: 0,
  connectCalls: 0,
}));

vi.mock('@/lib/hooks/use-voice-room', () => ({
  useVoiceRoom: () => ({
    roomState: room.roomState,
    agentState: 'idle',
    error: room.error,
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
  }),
}));

vi.mock('@alia.onl/sdk/voice', () => ({
  useAudioLevelMonitor: () => ({ captureLevel: 0, playbackLevel: 0 }),
  useAudioLevels: () => ({ waveAmplitude: 0 }),
}));

vi.mock('@oxy.so/bloom/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

import { useVoiceMode } from '@/lib/hooks/use-voice-mode';

type Harness = ReturnType<typeof useVoiceMode>;

/** Mounts the hook with no text messages at all — the case the old guard missed. */
function mountFromEmptyChat() {
  let api: Harness | null = null;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function Probe() {
    api = useVoiceMode({ chatMessages: [], setMessages: () => {} });
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
