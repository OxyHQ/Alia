import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The app's part of a voice call. The call itself — its states, what it says, when it ends — is
 * the SDK's (pinned in its `useVoiceLauncher` and `VoiceSession` tests); here is only what the
 * app answers: the gate, where a block sends the person, and what is refreshed.
 */
const sdk = vi.hoisted(() => ({ options: null as null | Record<string, unknown> }));
const host = vi.hoisted(() => ({
  isAuthenticated: true,
  entitled: true,
  credits: 10 as number | undefined,
  signIn: vi.fn(() => Promise.resolve()),
  push: vi.fn(),
}));

vi.mock('@alia.onl/sdk', () => ({
  useVoiceLauncher: (options: Record<string, unknown>) => {
    sdk.options = options;
    return { isActive: false, state: null, start: vi.fn(), end: vi.fn(), sessionProps: {} };
  },
}));
vi.mock('@oxy.so/services', () => ({
  useAuth: () => ({ isAuthenticated: host.isAuthenticated, signIn: host.signIn }),
  useOxy: () => ({ user: { id: 'u1' } }),
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
vi.mock('@/features/memory/runtime/user-data-store', () => ({
  useUserDataStore: (select: (s: unknown) => unknown) =>
    select({ memory: { preferences: { voice: 'male' } } }),
}));
vi.mock('@/features/voice/model/speech-locale', () => ({ speechLocale: () => 'es-ES' }));
vi.mock('@/shared/platform/config', () => ({ default: { apiUrl: 'https://api.test' } }));

import { useAppVoice } from '@/features/chat/runtime/use-app-voice';
import { queryKeys } from '@/shared/api/query-keys';

function mount(conversationId?: string) {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  function Probe() {
    useAppVoice({ ...(conversationId === undefined ? {} : { conversationId }) });
    return null;
  }
  act(() => {
    create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
  });
  const o = () => sdk.options as Record<string, (...args: never[]) => unknown>;
  return { invalidate, o };
}

beforeEach(() => {
  host.isAuthenticated = true;
  host.entitled = true;
  host.credits = 10;
  host.signIn.mockClear();
  host.push.mockClear();
});

describe('useAppVoice', () => {
  it('gives the SDK the app’s API, language and voice', () => {
    mount('conv-1');
    expect(sdk.options).toMatchObject({
      apiUrl: 'https://api.test',
      locale: 'es-ES',
      voice: 'male',
      conversationId: 'conv-1',
      accountId: 'u1',
    });
  });

  it('lets a signed-in person with a plan and credits call', () => {
    expect(mount().o().canStartVoice()).toBeNull();
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
    expect(mount().o().canStartVoice()).toBe(reason);
  });

  it('sends the person to sign in, or to the plans, when blocked', () => {
    const { o } = mount();
    o().onVoiceBlocked('sign-in' as never);
    expect(host.signIn).toHaveBeenCalledOnce();
    o().onVoiceBlocked('plan-required' as never);
    expect(host.push).toHaveBeenCalledWith('/(biglayout)/subscribe');
    o().onVoiceBlocked('credits-exhausted' as never);
    expect(host.push).toHaveBeenCalledOnce();
  });

  it('refreshes the thread when Alia stores messages, and credits when the call ends', () => {
    const { o, invalidate } = mount('conv-1');
    o().onMessagesSaved('conv-1' as never);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.conversations.detail('conv-1') });
    o().onCallEnded();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.credits.info });
  });
});
