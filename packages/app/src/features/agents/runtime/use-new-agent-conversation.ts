import { useTranslation } from '@/shared/i18n/use-translation';
import { useStartConversation } from '@alia.onl/sdk/runtime';
import { useAuth } from '@oxy.so/services/ui/client';
import { useCallback } from 'react';

/**
 * "New agent": a new agent is made by talking to Alia. This opens a conversation with her, with a
 * short first message in the person's language saying what they want; she asks what the agent is
 * for, and makes it (or edits it afterwards) with her own tools. Signed out there is no
 * conversation to open, so it asks to sign in instead.
 */
export function useNewAgentConversation() {
  const { t } = useTranslation();
  const startConversation = useStartConversation();
  const { isAuthenticated, signIn } = useAuth();
  return useCallback(() => {
    if (!isAuthenticated) {
      signIn().catch(() => {});
      return;
    }
    void startConversation(t('agents.createViaChat'));
  }, [isAuthenticated, signIn, startConversation, t]);
}
