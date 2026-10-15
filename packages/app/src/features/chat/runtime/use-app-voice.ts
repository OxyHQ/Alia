/**
 * What the Alia app tells the SDK's voice call about where it runs.
 *
 * The call itself — its bar, its states, what it says when it fails or ends, how it gives way to
 * another screen — is the SDK's (`useVoiceLauncher`, `VoiceSession`), the same one the bottom
 * sheet has. Here is only what belongs to the app: its API, the person's voice and language, the
 * plan and credits that gate a call (and where to send the person when they do), and what to
 * refresh when a call ends or Alia stores its messages.
 */

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useAuth, useOxy } from '@oxy.so/services';
import { type VoiceBlockReason, type VoiceLauncher, useVoiceLauncher } from '@alia.onl/sdk';
import config from '@/shared/platform/config';
import { queryKeys } from '@/shared/api/query-keys';
import { speechLocale } from '@/features/voice/model/speech-locale';
import { useUserDataStore } from '@/features/memory/runtime/user-data-store';
import { useEntitlements } from '@/features/billing/runtime/use-billing';
import { useCredits } from '@/features/billing/runtime/use-credits';

export interface UseAppVoiceOptions {
  /** The conversation the call speaks in and is stored in; absent on the new-chat screen. */
  conversationId?: string;
  /** The conversation's agent; omitted, Alia. */
  agentId?: string;
  /** Whether the screen holding the call is the one on show. */
  isFocused?: boolean;
  /**
   * Makes the conversation a call lives in when none is open (the new-chat screen), after the
   * gate; see `useVoiceLauncher`.
   */
  resolveConversation?: () => Promise<string | undefined>;
}

export function useAppVoice({
  conversationId,
  agentId,
  isFocused,
  resolveConversation,
}: UseAppVoiceOptions = {}): VoiceLauncher {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { isAuthenticated, signIn } = useAuth();
  const { user } = useOxy();
  const { data: entitlements } = useEntitlements();
  const { data: creditsInfo } = useCredits();
  const voicePref = useUserDataStore((s) => s.memory?.preferences?.voice);

  // An account, a plan with voice, and credits.
  const canStartVoice = useCallback((): VoiceBlockReason | null => {
    if (!isAuthenticated) return 'sign-in';
    if (!entitlements?.features['voice-mode']) return 'plan-required';
    if (creditsInfo && creditsInfo.credits <= 0) return 'credits-exhausted';
    return null;
  }, [isAuthenticated, entitlements, creditsInfo]);

  const onVoiceBlocked = useCallback(
    (reason: VoiceBlockReason) => {
      if (reason === 'sign-in') signIn().catch(() => {});
      else if (reason === 'plan-required') router.push('/(biglayout)/subscribe');
    },
    [signIn, router],
  );

  const onMessagesSaved = useCallback(
    (savedIn: string) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(savedIn) });
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all });
    },
    [queryClient],
  );

  // The call used credits per minute, and its transcript is in the thread.
  const onCallEnded = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.credits.info });
    if (conversationId !== undefined) {
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.detail(conversationId) });
    }
  }, [queryClient, conversationId]);

  return useVoiceLauncher({
    apiUrl: config.apiUrl,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(agentId === undefined ? {} : { agentId }),
    accountId: user?.id ?? null,
    ...(isFocused === undefined ? {} : { isFocused }),
    ...(resolveConversation === undefined ? {} : { resolveConversation }),
    locale: speechLocale(),
    voice: voicePref === 'male' ? 'male' : 'female',
    canStartVoice,
    onVoiceBlocked,
    onMessagesSaved,
    onCallEnded,
  });
}
