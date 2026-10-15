/**
 * What the Alia app tells the SDK's voice call about where it runs.
 *
 * The call itself — its bar, its states, what it says when it fails or ends, how it gives way to
 * another screen, where it lives — is the SDK's (`AliaChatContent`), the same one the bottom sheet
 * has. Here is only what belongs to the app: the plan and credits that gate a call (and where to
 * send the person when they do), what to refresh when a call ends, and the sounds it plays.
 */

import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxy.so/services';
import type { AliaVoiceOptions, VoiceBlockReason } from '@alia.onl/sdk';
import { queryKeys } from '@/shared/api/query-keys';
import { VOICE_SOUNDS } from '@/features/voice/model/voice-sounds';
import { useEntitlements } from '@/features/billing/runtime/use-billing';
import { useCredits } from '@/features/billing/runtime/use-credits';

export function useAppVoiceOptions(): AliaVoiceOptions {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { isAuthenticated, signIn } = useAuth();
  const { data: entitlements } = useEntitlements();
  const { data: creditsInfo } = useCredits();

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

  // The call used credits per minute.
  const onCallEnded = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.credits.info });
  }, [queryClient]);

  return useMemo(
    () => ({ canStartVoice, onVoiceBlocked, onCallEnded, sounds: VOICE_SOUNDS }),
    [canStartVoice, onVoiceBlocked, onCallEnded],
  );
}
