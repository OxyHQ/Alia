import apiClient, { getSocketToken } from '@/shared/api/client';
import config from '@/shared/platform/config';
import { errorMessage as getErrorMessage } from '@/shared/api/error-utils';
import { useTranslation } from '@/shared/i18n/use-translation';
import { useAuth, useOxy } from '@oxy.so/services';
import { useCallback, useEffect, useState } from 'react';
import { io as socketIO } from 'socket.io-client';

export type ChannelLinkStatus =
  | 'loading'
  | 'authorizing'
  | 'success'
  | 'error'
  | 'needLogin';

type Status = ChannelLinkStatus;

/** The bot routes a channel link goes through. */
const API_ROUTES_BOTS = {
  checkToken: (channelType: string, token: string) =>
    `/bots/internal/${channelType}/check-token/${token}`,
  link: (channelType: string) => `/bots/platform/${channelType}/link`,
};

/**
 * Linking a chat channel (Telegram, Discord, ...) to the signed-in account,
 * from the one-time token the bot handed out.
 *
 * Checks the token, asks for sign-in when there is no session, then links.
 * For Telegram it also listens on the socket, so a link completed from the
 * bot's side lands here without a reload.
 */
export function useChannelLink({
  token,
  app,
  channelType,
  displayName,
}: {
  /** The route's `token` param, as expo-router hands it over. */
  token: string | string[] | undefined;
  /** Which app the link is for; `telegram` also listens on the socket. */
  app: string;
  channelType: string;
  displayName: string;
}) {
  const { isLoading: authLoading, signIn } = useAuth();
  const { isAuthenticated: isOxyAuth } = useOxy();
  const { t } = useTranslation();

  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState('');

  // Bot auth handler for all bot types (Telegram, Discord, etc.)
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

  // Real-time socket subscription for Telegram token linking
  useEffect(() => {
    if (app !== 'telegram' || typeof token !== 'string' || !token) return;

    // The user is already authenticated on the authorize screen (it opens the
    // in-app sign-in modal otherwise), so the connection carries the Oxy bearer
    // token expected by the server's authSocket() middleware. The telegram token
    // is the one-time pairing code, distinct from the auth token.
    const socket = socketIO(config.apiUrl, {
      // Function form so a fresh token is read on every (re)connect.
      auth: (cb) => cb({ token: getSocketToken() }),
      transports: ['websocket'],
    });

    socket.on('connect', () => {
      socket.emit('subscribe-telegram-token', token);
    });

    socket.on('telegram-linked', () => {
      setStatus('success');
      setMessage(t('authorize.linkSuccess', { app: 'Telegram' }));
    });

    return () => {
      socket.disconnect();
    };
  }, [app, token]);

  return { authLoading, status, message, retry: handleChannelAuth };
}
