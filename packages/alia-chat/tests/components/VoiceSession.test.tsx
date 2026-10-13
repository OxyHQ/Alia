import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const room = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  connect: vi.fn(),
}));

vi.mock('../../src/hooks/useVoiceRoom', () => ({
  useVoiceRoom: () => ({
    room: null,
    roomState: 'disconnected',
    agentState: 'idle',
    isMuted: false,
    error: null,
    messages: [],
    isConnected: false,
    connect: room.connect,
    toggleMute: vi.fn(),
    ...room.state,
  }),
}));
vi.mock('../../src/hooks/useAudioLevelMonitor', () => ({
  useAudioLevelMonitor: () => ({ captureLevel: { value: 0 }, playbackLevel: { value: 0 } }),
}));
vi.mock('../../src/hooks/useAudioLevels', () => ({
  useAudioLevels: () => ({ waveAmplitude: { value: 0 } }),
}));
vi.mock('../../src/components/voice/VoiceControls', () => ({ VoiceControls: () => null }));

import { VoiceSession } from '../../src/components/voice/VoiceSession';
import { VOICE_ERROR_MESSAGES } from '../../src/lib/speech-messages';

function mount(state: Record<string, unknown>) {
  room.state = state;
  const onEnd = vi.fn();
  act(() => {
    TestRenderer.create(<VoiceSession onStateChange={vi.fn()} onEnd={onEnd} />);
  });
  return onEnd;
}

describe('VoiceSession', () => {
  beforeEach(() => {
    room.state = {};
    room.connect.mockClear();
  });

  it('dials once it is mounted', () => {
    mount({});

    expect(room.connect).toHaveBeenCalledOnce();
  });

  it('ends the call and says why when the connection fails', () => {
    const onEnd = mount({ roomState: 'error', error: 'Not authenticated' });

    expect(onEnd).toHaveBeenCalledWith('Not authenticated');
  });

  it('still says something when the room failed without a reason', () => {
    const onEnd = mount({ roomState: 'error', error: null });

    expect(onEnd).toHaveBeenCalledWith(VOICE_ERROR_MESSAGES['turn-failed']);
  });

  it('does not end a call that has not been placed yet', () => {
    const onEnd = mount({ roomState: 'disconnected' });

    expect(onEnd).not.toHaveBeenCalled();
  });

  it('ends a call whose room went away after it was reached, without an error', () => {
    const onEnd = vi.fn();
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    room.state = { roomState: 'connected' };
    act(() => {
      renderer = TestRenderer.create(<VoiceSession onStateChange={vi.fn()} onEnd={onEnd} />);
    });
    room.state = { roomState: 'disconnected' };
    act(() => renderer?.update(<VoiceSession onStateChange={vi.fn()} onEnd={onEnd} />));

    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith();
  });
});
