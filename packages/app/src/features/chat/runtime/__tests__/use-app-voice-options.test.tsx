import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The app's part of a voice call. The call itself — its states, what it says, when it ends, where
 * it lives — is the SDK's (pinned in its `useVoiceLauncher`, `VoiceSession` and
 * `AliaChatContent` tests); here is only what the app answers: the gate, where a block sends the
 * person, what is refreshed when a call ends, and the sounds it plays.
 */
const host = vi.hoisted(() => ({
  isAuthenticated: true,
  entitled: true,
  credits: 10 as number | undefined,
  signIn: vi.fn(() => Promise.resolve()),
  push: vi.fn(),
}));

vi.mock('@oxy.so/services', () => ({
  useAuth: () => ({ isAuthenticated: host.isAuthenticated, signIn: host.signIn }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: host.push }) }));
vi.mock('@/features/billing/runtime/use-billing', () => ({
  useEntitlements: () => ({ data: { features: { 'voice-mode': host.entitled } } }),
}));
vi.mock('@/features/billing/runtime/use-credits', () => ({
  useCredits: () => ({
    data: host.credits === undefined ? undefined : { credits: host.credits },
  }),
}));
vi.mock('@/features/voice/model/voice-sounds', () => ({
  VOICE_SOUNDS: { thinking: 'thinking.mp3' },
}));

import type { AliaVoiceOptions } from '@alia.onl/sdk';
import { useAppVoiceOptions } from '@/features/chat/runtime/use-app-voice-options';
import { queryKeys } from '@/shared/api/query-keys';

function mount() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const seen: { options: AliaVoiceOptions | null } = { options: null };
  function Probe() {
    seen.options = useAppVoiceOptions();
    return null;
  }
  act(() => {
    create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  });
  const options = (): Required<
    Pick<AliaVoiceOptions, 'canStartVoice' | 'onVoiceBlocked' | 'onCallEnded'>
  > &
    AliaVoiceOptions => seen.options as never;
  return { invalidate, options };
}

beforeEach(() => {
  host.isAuthenticated = true;
  host.entitled = true;
  host.credits = 10;
  host.signIn.mockClear();
  host.push.mockClear();
});

describe('useAppVoiceOptions', () => {
  it('lets a signed-in person with a plan and credits call', () => {
    expect(mount().options().canStartVoice()).toBeNull();
  });

  it.each([
    [
      'sign-in',
      () => {
        host.isAuthenticated = false;
      },
    ],
    [
      'plan-required',
      () => {
        host.entitled = false;
      },
    ],
    [
      'credits-exhausted',
      () => {
        host.credits = 0;
      },
    ],
  ] as const)('blocks a call for %s', (reason, setUp: () => unknown) => {
    setUp();
    expect(mount().options().canStartVoice()).toBe(reason);
  });

  it('sends the person to sign in, or to the plans, when blocked', () => {
    const { options } = mount();
    options().onVoiceBlocked('sign-in');
    expect(host.signIn).toHaveBeenCalledOnce();
    options().onVoiceBlocked('plan-required');
    expect(host.push).toHaveBeenCalledWith('/(biglayout)/subscribe');
    options().onVoiceBlocked('credits-exhausted');
    expect(host.push).toHaveBeenCalledOnce();
  });

  it('refreshes the credits when a call ends: the call used them per minute', () => {
    const { options, invalidate } = mount();
    options().onCallEnded();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.credits.info });
  });

  it('brings the app’s own sounds for the call to play', () => {
    expect(mount().options().sounds).toEqual({ thinking: 'thinking.mp3' });
  });
});
