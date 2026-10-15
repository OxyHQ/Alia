import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Voice mode over the SDK's call (ADR 0017), with the call itself faked: what
 * is pinned is the app's part — the call is opened for this conversation and
 * its agent, the thread is refreshed when Alia stores messages, a failure is
 * said in the app's language, a call moved to another device is said as
 * information, and leaving the screen, the conversation or the account ends it.
 */

type CallState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'listening' }
  | { kind: 'ended'; reason: string }
  | { kind: 'error'; code: string };

const room = vi.hoisted(() => ({
  options: null as null | {
    conversationId: string;
    agentId?: string;
    onMessagesSaved?: (conversationId: string, ids: readonly string[]) => void;
  },
  state: { kind: 'idle' } as CallState,
  endingSoonMs: null as number | null,
  disconnectCalls: 0,
  connectCalls: 0,
}));

const toasts = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
}));

vi.mock('@/features/voice/runtime/use-voice-room', () => ({
  useVoiceRoom: (options: typeof room.options) => {
    room.options = options;
    const state = room.state;
    const roomState =
      state.kind === 'idle' || state.kind === 'ended'
        ? 'disconnected'
        : state.kind === 'error'
          ? 'error'
          : state.kind === 'connecting'
            ? 'connecting'
            : 'connected';
    return {
      callState: state,
      roomState,
      agentState: state.kind === 'listening' ? 'listening' : 'idle',
      errorCode: state.kind === 'error' ? state.code : null,
      endedReason: state.kind === 'ended' ? state.reason : null,
      endingSoonMs: room.endingSoonMs,
      messages: [],
      isMuted: false,
      isConnected: roomState === 'connected',
      room: null,
      connect: async () => {
        room.connectCalls += 1;
      },
      disconnect: () => {
        room.disconnectCalls += 1;
        room.state = { kind: 'idle' };
      },
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
vi.mock('@/shared/i18n/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => `t:${key}` }),
}));

import { useVoiceMode } from '@/features/voice/runtime/use-voice-mode';
import { queryKeys } from '@/shared/api/query-keys';

type Harness = ReturnType<typeof useVoiceMode>;

interface Scope {
  owner: string;
  isFocused: boolean;
  conversationId: string;
  agentId?: string;
}

function mount(initial: Partial<Scope> = {}) {
  let api: Harness | null = null;
  let scope: Scope = {
    owner: 'user-a:conv-1',
    isFocused: true,
    conversationId: 'conv-1',
    ...initial,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');

  function Probe(props: Scope) {
    api = useVoiceMode(props);
    return null;
  }
  const tree = () =>
    React.createElement(QueryClientProvider, { client }, React.createElement(Probe, scope));

  let renderer: ReturnType<typeof create>;
  act(() => {
    renderer = create(tree());
  });

  return {
    invalidate,
    get api() {
      if (!api) throw new Error('hook did not render');
      return api;
    },
    setCall(next: CallState) {
      room.state = next;
      act(() => {
        renderer.update(tree());
      });
    },
    setScope(next: Partial<Scope>) {
      scope = { ...scope, ...next };
      act(() => {
        renderer.update(tree());
      });
    },
  };
}

function liveCall(initial: Partial<Scope> = {}) {
  const harness = mount(initial);
  act(() => {
    harness.api.activateVoice();
  });
  harness.setCall({ kind: 'listening' });
  expect(harness.api.isVoiceActive).toBe(true);
  return harness;
}

beforeEach(() => {
  room.options = null;
  room.state = { kind: 'idle' };
  room.endingSoonMs = null;
  room.disconnectCalls = 0;
  room.connectCalls = 0;
  for (const fn of Object.values(toasts)) fn.mockReset();
});

describe('useVoiceMode — the call is this conversation’s', () => {
  it('opens the call for the conversation and its agent', () => {
    const harness = mount({ conversationId: 'conv-7', agentId: 'agent-3', owner: 'u:conv-7' });
    expect(room.options).toMatchObject({ conversationId: 'conv-7', agentId: 'agent-3' });
    act(() => {
      harness.api.activateVoice();
    });
    expect(room.connectCalls).toBe(1);
    expect(harness.api.isVoiceActive).toBe(true);
  });

  it('refreshes the thread when Alia stores messages of the call', () => {
    const harness = liveCall();
    act(() => room.options?.onMessagesSaved?.('conv-1', ['m1']));
    expect(harness.invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.conversations.detail('conv-1'),
    });
  });

  it('refreshes credits and the thread when the call ends', () => {
    const harness = liveCall();
    act(() => harness.api.deactivateVoice());
    expect(room.disconnectCalls).toBe(1);
    expect(harness.invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.credits.info });
    expect(harness.api.isVoiceActive).toBe(false);
  });

  it('leaves a call that is still connecting alone', () => {
    const harness = mount();
    act(() => {
      harness.api.activateVoice();
    });
    harness.setCall({ kind: 'idle' });
    harness.setCall({ kind: 'connecting' });
    expect(harness.api.isVoiceActive).toBe(true);
    expect(room.disconnectCalls).toBe(0);
  });
});

describe('useVoiceMode — what the person is told, in their language', () => {
  it.each([
    'plan-required',
    'credits-exhausted',
    'mic-denied',
    'realtime-unavailable',
    'connection-lost',
  ])('ends a call that failed (%s) and says why, translated', (code) => {
    const harness = liveCall();
    harness.setCall({ kind: 'error', code });
    expect(toasts.error).toHaveBeenCalledWith(`t:voice.errors.${code}`);
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(harness.api.isVoiceActive).toBe(false);
    expect(room.disconnectCalls).toBe(1);
  });

  it('says a call moved to another device as information, never as an error', () => {
    const harness = liveCall();
    harness.setCall({ kind: 'ended', reason: 'call-moved-elsewhere' });
    expect(toasts.info).toHaveBeenCalledWith('t:voice.ended.call-moved-elsewhere');
    expect(toasts.error).not.toHaveBeenCalled();
    expect(harness.api.isVoiceActive).toBe(false);
  });

  it('says nothing more for a hang-up', () => {
    const harness = liveCall();
    harness.setCall({ kind: 'ended', reason: 'hangup' });
    expect(toasts.info).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
    expect(harness.api.isVoiceActive).toBe(false);
  });

  it('warns once the call is about to reach its limit, and shows it in the bar', () => {
    const harness = liveCall();
    room.endingSoonMs = 60_000;
    harness.setCall({ kind: 'listening' });
    expect(harness.api.notice).toBe('t:voice.endingSoon');
    expect(toasts.warning).toHaveBeenCalledWith('t:voice.endingSoon');
  });
});

describe('useVoiceMode — navigation and account switches end the call', () => {
  it('ends the call when another route covers its screen', () => {
    const harness = liveCall();
    harness.setScope({ isFocused: false });
    expect(harness.api.isVoiceActive).toBe(false);
    expect(room.disconnectCalls).toBe(1);
  });

  it('ends the call when the screen moves to another conversation', () => {
    const harness = liveCall();
    harness.setScope({ owner: 'user-a:conv-2', conversationId: 'conv-2' });
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
    const harness = mount({ isFocused: false });
    act(() => {
      harness.api.activateVoice();
    });
    expect(harness.api.isVoiceActive).toBe(false);
    expect(room.connectCalls).toBe(0);
  });
});
