import { AuthContainer } from '@/components/auth/auth-container';
import { AuthLogo } from '@/components/auth/auth-logo';
import apiClient, { getSocketToken } from '@/lib/api/client';
import config from '@/lib/config';
import { errorMessage as getErrorMessage } from '@/lib/errors/error-utils';
import { useTranslation } from '@/lib/hooks/use-translation';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { Loading } from '@oxy.so/bloom/loading';
import { Muted } from '@oxy.so/bloom/typography';
import { useAuth, useOxy } from '@oxy.so/services';
import { useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform } from 'react-native';
import { io as socketIO } from 'socket.io-client';

/**
 * Links a chat channel (Telegram, Discord, ...) to the signed-in account.
 *
 * This screen once also ran a PKCE authorize flow for Codea and Cowork against
 * `POST /auth/authorize/:app`. Both clients sign in with Oxy directly now and
 * that endpoint is gone, so the channel link is the only flow left here.
 */
type Status = 'loading' | 'authorizing' | 'success' | 'error' | 'needLogin';

const CHANNEL_NAMES: Record<string, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
};

function channelDisplayName(channel: string): string {
  return CHANNEL_NAMES[channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}

export default function AuthorizeScreen() {
  const params = useLocalSearchParams();
  const { isLoading: authLoading, signIn } = useAuth();
  const { isAuthenticated: isOxyAuth } = useOxy();
  const { t } = useTranslation();

  const app = typeof params.app === 'string' && params.app ? params.app : 'telegram';
  const channel = params.channel as string | undefined;
  const displayName = channelDisplayName(channel || app);

  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState('');

  // Bot auth handler for all bot types (Telegram, Discord, etc.)
  const handleChannelAuth = useCallback(async () => {
    const { token } = params;
    const channelType = channel || app;

    setStatus('authorizing');

    if (!token || typeof token !== 'string') {
      setStatus('error');
      setMessage(t('authorize.invalidToken'));
      return;
    }

    // Verify token is valid via bot route
    try {
      const res = await apiClient.get(`/bots/internal/${channelType}/check-token/${token}`);
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
      const response = await apiClient.post(`/bots/platform/${channelType}/link`, {
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
  }, [params, isOxyAuth, signIn, channel, app, displayName, t]);

  useEffect(() => {
    if (authLoading) return;

    if (params.token) {
      handleChannelAuth();
    } else {
      setStatus('error');
      setMessage(t('authorize.missingToken'));
    }
  }, [authLoading, params.token, handleChannelAuth, t]);

  // Real-time socket subscription for Telegram token linking
  useEffect(() => {
    const token = params.token as string | undefined;
    if (app !== 'telegram' || !token) return;

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
  }, [app, params.token]);

  if (authLoading || status === 'loading') {
    return (
      <AuthContainer>
        <AuthLogo />
        <Loading text={t('common.loading')} />
      </AuthContainer>
    );
  }

  const requestNewLink = () => {
    const botUsername = process.env.EXPO_PUBLIC_TELEGRAM_BOT_USERNAME || 'alia_onlbot';
    const botUrl = `https://t.me/${botUsername}?start=link`;
    if (Platform.OS === 'web') {
      window.open(botUrl, '_blank');
    } else {
      Linking.openURL(botUrl);
    }
  };

  return (
    <>
      <Head>
        <title>{t('authorize.authorizeApp', { app: displayName })}</title>
        <meta name="description" content={t('authorize.appWantsAccess', { app: displayName })} />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <AuthContainer>
        <AuthLogo />

        {status === 'authorizing' && (
          <EmptyState
            illustration={<Loading />}
            title={t('authorize.linkingAccount')}
            description={t('authorize.pleaseWait')}
          />
        )}

        {status === 'needLogin' && (
          <EmptyState
            icon={RiLockLine}
            media="circle"
            title={t('authorize.authRequired')}
            description={message}
          />
        )}

        {status === 'success' && (
          <EmptyState
            icon={RiCheckboxCircleLine}
            media="circle"
            title={t('authorize.linked')}
            description={message}
            footer={
              <Muted className="text-center">{t('authorize.returnToApp', { app: displayName })}</Muted>
            }
          />
        )}

        {status === 'error' && (
          <EmptyState
            icon={RiCloseCircleLine}
            media="circle"
            title={t('authorize.linkFailed')}
            description={message}
            action={
              message.includes('expired')
                ? { label: t('authorize.requestNewLink'), onPress: requestNewLink }
                : { label: t('common.tryAgain'), onPress: handleChannelAuth }
            }
          />
        )}
      </AuthContainer>
    </>
  );
}
