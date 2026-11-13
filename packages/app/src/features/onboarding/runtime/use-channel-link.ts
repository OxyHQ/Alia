import apiClient from '@/shared/api/client';
import { errorMessage as getErrorMessage } from '@/shared/api/error-utils';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';
import { useCallback, useEffect, useState } from 'react';

type ChannelLinkStatus = 'loading' | 'authorizing' | 'success' | 'error' | 'needLogin';

type Status = ChannelLinkStatus;

/** The bot routes a channel link goes through. */
const API_ROUTES_BOTS = {
  checkToken: (channelType: string, token: string) =>
    `/bots/internal/${channelType}/check-token/${token}`,
  link: (channelType: string) => `/bots/platform/${channelType}/link`,
};

/**
 * Linking a system bot's chat (Discord) to the signed-in account, from the one-time token the bot
 * handed out. Checks the token, asks for sign-in when there is no session, then links.
 *
 * Telegram is not linked here: a person's Telegram is a gemie's connected account, linked from the
 * gemie's editor (ADR 0037).
 */
export function useChannelLink({
  token,
  channelType,
  displayName,
}: {
  /** The route's `token` param, as expo-router hands it over. */
  token: string | string[] | undefined;
  channelType: string;
  displayName: string;
}) {
  const { isLoading: authLoading, signIn } = useAuth();
  const { isAuthenticated: isOxyAuth } = useOxy();
  const { t } = useTranslation();

  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState('');

  const handleChannelAuth = useCallback(async () => {
    setStatus('authorizing');

    if (!token || typeof token !== 'string') {
      setStatus('error');
      setMessage(t('authorize.invalidToken'));
      return;
    }

    // Verify token is valid via bot route
    try {
      const res = await apiClient.get(API_ROUTES_BOTS.checkToken(channelType, token));
      if (!res.data?.valid) {
        setStatus('error');
        setMessage(res.data?.error || t('authorize.tokenExpired'));
        return;
      }
    } catch (e: unknown) {
      setStatus('error');
      setMessage(t('authorize.invalidOrExpiredToken'));
      return;
    }

    if (!isOxyAuth) {
      setStatus('needLogin');
      setMessage(t('authorize.needLogin', { app: displayName }));
      signIn().catch(() => {});
      return;
    }

    // Link via bot platform route
    try {
      const response = await apiClient.post(API_ROUTES_BOTS.link(channelType), {
        authToken: token,
      });
      if (response.data.success) {
        setStatus('success');
        setMessage(t('authorize.linkSuccess', { app: displayName }));
      } else {
        setStatus('error');
        setMessage(t('authorize.failedToLink'));
      }
    } catch (error: unknown) {
      console.error('Bot link error:', error);
      const errorMessage = getErrorMessage(error, t('authorize.failedToLink'));
      setStatus('error');
      setMessage(errorMessage);
    }
  }, [token, isOxyAuth, signIn, channelType, displayName, t]);

  useEffect(() => {
    if (authLoading) return;

    if (token) {
      handleChannelAuth();
    } else {
      setStatus('error');
      setMessage(t('authorize.missingToken'));
    }
  }, [authLoading, token, handleChannelAuth, t]);

  return { authLoading, status, message, retry: handleChannelAuth };
}
