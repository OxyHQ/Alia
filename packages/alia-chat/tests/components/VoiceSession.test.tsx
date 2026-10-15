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
    errorCode: null,
    endedReason: null,
    endingSoonMs: null,
    callState: { kind: 'idle' },
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
vi.mock('@oxy.so/bloom/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('../../src/components/voice/VoiceControls', () => ({ VoiceControls: () => null }));

import { VoiceSession } from '../../src/components/voice/VoiceSession';
import { VOICE_ERROR_MESSAGES } from '../../src/lib/speech-messages';
import { AliaChatLabelsProvider, DEFAULT_LABELS } from '../../src/lib/labels';

function mount(state: Record<string, unknown>) {
  room.state = state;
  const onEnd = vi.fn();
  const onNotice = vi.fn();
  act(() => {
    TestRenderer.create(<VoiceSession onStateChange={vi.fn()} onEnd={onEnd} onNotice={onNotice} />);
  });
  return { onEnd, onNotice };
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

  it.each(['plan-required', 'credits-exhausted', 'mic-denied', 'connection-lost'] as const)(
    'ends a call that failed (%s) and says why, once',
    (code) => {
      const { onEnd, onNotice } = mount({ roomState: 'error', errorCode: code });

      expect(onNotice).toHaveBeenCalledOnce();
      expect(onNotice).toHaveBeenCalledWith({ kind: 'error', text: VOICE_ERROR_MESSAGES[code] });
      expect(onEnd).toHaveBeenCalledOnce();
    },
  );

  it('still says something when the room failed without a code', () => {
    const { onEnd, onNotice } = mount({ roomState: 'error' });

    expect(onNotice).toHaveBeenCalledWith({
      kind: 'error',
      text: VOICE_ERROR_MESSAGES['realtime-failed'],
    });
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('does not end a call that has not been placed yet', () => {
    const { onEnd, onNotice } = mount({ roomState: 'disconnected' });

    expect(onEnd).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('uses the host labels for what it says', () => {
    const onNotice = vi.fn();
    room.state = { roomState: 'error', errorCode: 'mic-denied' };
    act(() => {
      TestRenderer.create(
        <AliaChatLabelsProvider labels={{ voiceError: (code) => `t:${code}` }}>
          <VoiceSession onStateChange={vi.fn()} onEnd={vi.fn()} onNotice={onNotice} />
        </AliaChatLabelsProvider>,
      );
    });

    expect(onNotice).toHaveBeenCalledWith({ kind: 'error', text: 't:mic-denied' });
  });

  describe('a call that was reached', () => {
    function reach(next: Record<string, unknown>) {
      const onEnd = vi.fn();
      const onNotice = vi.fn();
      const tree = () => <VoiceSession onStateChange={vi.fn()} onEnd={onEnd} onNotice={onNotice} />;
      let renderer: TestRenderer.ReactTestRenderer | null = null;
      room.state = { roomState: 'connected' };
      act(() => {
        renderer = TestRenderer.create(tree());
      });
      room.state = next;
      act(() => renderer?.update(tree()));
      return { onEnd, onNotice };
    }

    it('ends without a word when the person hung up', () => {
      const { onEnd, onNotice } = reach({ roomState: 'disconnected', endedReason: 'hangup' });

      expect(onEnd).toHaveBeenCalledOnce();
      expect(onNotice).not.toHaveBeenCalled();
    });

    it('says a call moved to another device as information, never as an error', () => {
      const { onEnd, onNotice } = reach({
        roomState: 'disconnected',
        endedReason: 'call-moved-elsewhere',
      });

      expect(onNotice).toHaveBeenCalledOnce();
      expect(onNotice).toHaveBeenCalledWith({
        kind: 'info',
        text: DEFAULT_LABELS.voiceEnded('call-moved-elsewhere'),
      });
      expect(onEnd).toHaveBeenCalledOnce();
    });

    it('ends when the room went away, without a notice', () => {
      const { onEnd, onNotice } = reach({ roomState: 'disconnected' });

      expect(onEnd).toHaveBeenCalledOnce();
      expect(onNotice).not.toHaveBeenCalled();
    });
  });

  it('warns once that the call is about to reach its limit', () => {
    const onNotice = vi.fn();
    const tree = () => <VoiceSession onStateChange={vi.fn()} onEnd={vi.fn()} onNotice={onNotice} />;
    room.state = { roomState: 'connected', endingSoonMs: 60_000 };
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    act(() => {
      renderer = TestRenderer.create(tree());
    });
    act(() => renderer?.update(tree()));

    expect(onNotice).toHaveBeenCalledOnce();
    expect(onNotice).toHaveBeenCalledWith({
      kind: 'warning',
      text: DEFAULT_LABELS.voiceEndingSoon,
    });
  });
});
