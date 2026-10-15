import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where a call lives on the app's two chat screens — the same rule as the SDK's sheet.
 *
 * The app's new-chat route and its conversation route are different screens, each with its own
 * `useAppVoice`. With a conversation open the call lives in it; on the new-chat route it is made
 * after the gate, the route is replaced by that conversation's, and the call opens THERE. Here the
 * app's hook runs over the SDK's real launcher; only the gate's data and the router are stubbed.
 */

vi.mock('@alia.onl/sdk', async () => ({
  useVoiceLauncher: (await import('../../../../../../alia-chat/src/hooks/useVoiceLauncher'))
    .useVoiceLauncher,
}));
vi.mock('@oxy.so/bloom/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@oxy.so/services', () => ({
  useAuth: () => ({ isAuthenticated: true, signIn: vi.fn() }),
  useOxy: () => ({ user: { id: 'u1' } }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/features/billing/runtime/use-billing', () => ({
  useEntitlements: () => ({ data: { features: { 'voice-mode': true } } }),
}));
vi.mock('@/features/billing/runtime/use-credits', () => ({
  useCredits: () => ({ data: { credits: 10 } }),
}));
vi.mock('@/features/memory/runtime/user-data-store', () => ({
  useUserDataStore: (select: (s: unknown) => unknown) => select({ memory: null }),
}));
vi.mock('@/features/voice/model/speech-locale', () => ({ speechLocale: () => 'en-US' }));
vi.mock('@/shared/platform/config', () => ({ default: { apiUrl: 'https://api.test' } }));

import { useAppVoice, type UseAppVoiceOptions } from '@/features/chat/runtime/use-app-voice';
import { useVoiceCallRequests } from '../../../../../../alia-chat/src/lib/voice-call-request';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Voice = ReturnType<typeof useAppVoice>;
const renderers: ReactTestRenderer[] = [];

/** A screen holding a call launcher: `read()` is its latest state. */
function screen(options: UseAppVoiceOptions) {
  let voice: Voice | null = null;
  function Probe() {
    voice = useAppVoice(options);
    return null;
  }
  act(() => {
    renderers.push(
      create(
        <QueryClientProvider client={new QueryClient()}>
          <Probe />
        </QueryClientProvider>,
      ),
    );
  });
  return () => {
    if (!voice) throw new Error('did not render');
    return voice as Voice;
  };
}

beforeEach(() => useVoiceCallRequests.getState().clear());
afterEach(() => {
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount());
});

describe('the conversation screen', () => {
  it('opens the call in its conversation, and makes no other', async () => {
    const resolveConversation = vi.fn(async () => 'made');
    const read = screen({ conversationId: 'c1', resolveConversation });
    await act(async () => read().start());

    expect(resolveConversation).not.toHaveBeenCalled();
    expect(read().isActive).toBe(true);
    expect(read().sessionProps.conversationId).toBe('c1');
  });
});

describe('the new-chat route', () => {
  it('makes the conversation after the gate and leaves the call to the screen that shows it', async () => {
    const resolveConversation = vi.fn(async () => 'made');
    const newChat = screen({ resolveConversation });
    await act(async () => newChat().start());

    expect(resolveConversation).toHaveBeenCalledOnce();
    expect(newChat().isActive).toBe(false);

    // The router replaced this route with the conversation's: that screen takes the call.
    const conversationScreen = screen({ conversationId: 'made' });
    expect(conversationScreen().isActive).toBe(true);
    expect(conversationScreen().sessionProps.conversationId).toBe('made');
  });

  it('opens nothing when the conversation could not be made', async () => {
    const newChat = screen({ resolveConversation: async () => undefined });
    await act(async () => newChat().start());

    expect(screen({ conversationId: 'anything' })().isActive).toBe(false);
  });
});
