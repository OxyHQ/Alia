import { AuthContainer } from '@/components/auth/auth-container';
import { AuthLogo } from '@/components/auth/auth-logo';
import apiClient, { getSocketToken } from '@/lib/api/client';
import config from '@/lib/config';
import { errorMessage as getErrorMessage } from '@/lib/errors/error-utils';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import {
  Card,
  CardBody,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@oxy.so/bloom/card';
import { Divider } from '@oxy.so/bloom/divider';
import { EmptyState } from '@oxy.so/bloom/empty-state';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted } from '@oxy.so/bloom/typography';
import { useAuth, useOxy } from '@oxy.so/services';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { io as socketIO } from 'socket.io-client';

type AppType = string;
type Status =
  'loading' | 'authorize' | 'authorizing' | 'success' | 'error' | 'needLogin';

interface AppConfig {
  name: string;
  displayName: string;
  permissionKeys: string[];
  isChannel?: boolean;
}

const APP_CONFIGS: Record<string, AppConfig> = {
  codea: {
    name: 'codea',
    displayName: 'Alia Codea',
    permissionKeys: ['sendMessages', 'useCredits', 'accessModels'],
  },
  cowork: {
    name: 'cowork',
    displayName: 'Alia Cowork',
    permissionKeys: ['sendMessages', 'useCredits', 'accessModels'],
  },
  telegram: {
    name: 'telegram',
    displayName: 'Telegram',
    permissionKeys: ['linkAccount', 'sendVia', 'receiveNotifications'],
    isChannel: true,
  },
  discord: {
    name: 'discord',
    displayName: 'Discord',
    permissionKeys: ['linkAccount', 'sendVia', 'receiveNotifications'],
    isChannel: true,
  },
};

function getAppConfig(app: string): AppConfig {
  return (
    APP_CONFIGS[app] || {
      name: app,
      displayName: app.charAt(0).toUpperCase() + app.slice(1),
      permissionKeys: ['linkAccount', 'sendVia'],
      isChannel: true,
    }
  );
}

export default function AuthorizeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { isAuthenticated, isLoading: authLoading, signIn } = useAuth();
  const { isAuthenticated: isOxyAuth } = useOxy();
  const { t } = useTranslation();
  const { colors } = useTheme();

  // Determine app type from params
  const app = (params.app as AppType) || 'codea';
  const channel = params.channel as string | undefined;
  const appConfig = getAppConfig(app);

  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState('');
  const [redirectUrl, setRedirectUrl] = useState('');

  // Handle OAuth flow (Codea/Cowork)
  const handleOAuthAuthorize = async () => {
    const { callback, code_challenge, code_challenge_method } = params;

    if (!callback || typeof callback !== 'string') {
      setStatus('error');
      setMessage(t('authorize.invalidCallback'));
      return;
    }

    if (!code_challenge || typeof code_challenge !== 'string') {
      setStatus('error');
      setMessage(t('authorize.invalidPKCE'));
      return;
    }

    setStatus('authorizing');

    try {
      const response = await apiClient.post(`/auth/authorize/${app}`, {
        code_challenge,
        code_challenge_method: code_challenge_method || 'S256',
      });
      const { code } = response.data;

      if (!code) {
        throw new Error('No authorization code received');
      }

      const callbackUrl = new URL(callback);
      callbackUrl.searchParams.set('code', code);
      const finalUrl = callbackUrl.toString();

      setRedirectUrl(finalUrl);
      setStatus('success');
      setMessage(t('authorize.authSuccess'));

      setTimeout(() => {
        try {
          window.location.replace(finalUrl);
        } catch (e) {
          console.error('Redirect failed:', e);
          window.location.href = finalUrl;
        }
      }, 1000);
    } catch (error: unknown) {
      console.error('Authorization error:', error);
      setStatus('error');
      setMessage(getErrorMessage(error, t('authorize.failedToAuthorize')));
    }
  };

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
      const res = await apiClient.get(
        `/bots/internal/${channelType}/check-token/${token}`,
      );
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
      setMessage(t('authorize.needLogin', { app: appConfig.displayName }));
      signIn().catch(() => {});
      return;
    }

    // Link via bot platform route
    try {
      const response = await apiClient.post(
        `/bots/platform/${channelType}/link`,
        {
          authToken: token,
        },
      );
      if (response.data.success) {
        setStatus('success');
        setMessage(t('authorize.linkSuccess', { app: appConfig.displayName }));
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
  }, [params, isOxyAuth, signIn, channel, app, appConfig.displayName]);

  useEffect(() => {
    if (authLoading) return;

    if (appConfig.isChannel || channel) {
      // Bot flow (Telegram, Discord, etc.) using /bots/* endpoints
      if (params.token) {
        handleChannelAuth();
      } else {
        setStatus('error');
        setMessage(t('authorize.missingToken'));
      }
    } else {
      // OAuth flow for Codea/Cowork
      if (!isAuthenticated) {
        setStatus('needLogin');
        setMessage(t('authorize.needLogin', { app: appConfig.displayName }));
        signIn().catch(() => {});
        return;
      }
      setStatus('authorize');
    }
  }, [
    isAuthenticated,
    authLoading,
    app,
    channel,
    params,
    signIn,
    handleChannelAuth,
    appConfig.isChannel,
  ]);

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

  const handleCancel = () => {
    const { callback } = params;
    if (callback && typeof callback === 'string') {
      try {
        const callbackUrl = new URL(callback);
        callbackUrl.searchParams.set('error', 'user_cancelled');
        window.location.href = callbackUrl.toString();
      } catch {
        router.back();
      }
    } else {
      router.back();
    }
  };

  if (authLoading || status === 'loading') {
    return (
      <AuthContainer>
        <AuthLogo />
        <Loading text={t('common.loading')} />
      </AuthContainer>
    );
  }

  const openRedirect = () => {
    if (Platform.OS === 'web') {
      const link = document.createElement('a');
      link.href = redirectUrl;
      link.click();
    } else {
      Linking.openURL(redirectUrl);
    }
  };

  const requestNewLink = () => {
    const botUsername =
      process.env.EXPO_PUBLIC_TELEGRAM_BOT_USERNAME || 'alia_onlbot';
    const botUrl = `https://t.me/${botUsername}?start=link`;
    if (Platform.OS === 'web') {
      window.open(botUrl, '_blank');
    } else {
      Linking.openURL(botUrl);
    }
  };

  const retry = () => {
    if (appConfig.isChannel || channel) {
      handleChannelAuth();
    } else {
      setStatus('authorize');
    }
  };

  return (
    <>
      <Head>
        <title>
          {t('authorize.authorizeApp', { app: appConfig.displayName })}
        </title>
        <meta
          name="description"
          content={t('authorize.appWantsAccess', {
            app: appConfig.displayName,
          })}
        />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <AuthContainer>
        <AuthLogo />

        {status === 'authorize' && (
          <Card appearance="outline">
            <CardHeader>
              <CardTitle>
                {t('authorize.authorizeApp', { app: appConfig.displayName })}
              </CardTitle>
              <CardDescription>
                {t('authorize.appWantsAccess', {
                  app: appConfig.displayName,
                })}
              </CardDescription>
            </CardHeader>
            <CardBody>
              <Muted>
                {t('authorize.willAllow', { app: appConfig.displayName })}
              </Muted>
              {appConfig.permissionKeys.map((key) => (
                <Item
                  key={key}
                  role="listitem"
                  density="compact"
                  leading={
                    <RiCheckLine width={16} height={16} fill={colors.success} />
                  }
                  title={t(`authorize.${key}`, {
                    app: appConfig.displayName,
                  })}
                />
              ))}
              <Divider spacing={8} />
            </CardBody>
            <CardFooter>
              <View className="flex-1 gap-2">
                <Button tone="action" size="lg" onPress={handleOAuthAuthorize}>
                  {t('common.authorize')}
                </Button>
                <Button
                  tone="neutral"
                  appearance="subtle"
                  size="lg"
                  onPress={handleCancel}
                >
                  {t('common.cancel')}
                </Button>
              </View>
            </CardFooter>
          </Card>
        )}

        {status === 'authorizing' && (
          <EmptyState
            illustration={<Loading />}
            title={
              appConfig.isChannel
                ? t('authorize.linkingAccount')
                : t('authorize.authorizing')
            }
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
            title={
              appConfig.isChannel
                ? t('authorize.linked')
                : t('authorize.authorized')
            }
            description={message}
            action={
              redirectUrl
                ? { label: t('authorize.openAppManually'), onPress: openRedirect }
                : undefined
            }
            footer={
              redirectUrl ? (
                <Muted selectable className="text-center text-sm leading-5 text-muted-foreground">
                  {redirectUrl}
                </Muted>
              ) : appConfig.isChannel ? (
                <Muted className="text-center text-sm leading-5 text-muted-foreground">
                  You can now return to {appConfig.displayName} and start
                  chatting with Alia!
                </Muted>
              ) : (
                <Muted className="text-center text-sm leading-5 text-muted-foreground">
                  If not redirected automatically, you can close this window.
                </Muted>
              )
            }
          />
        )}

        {status === 'error' && (
          <EmptyState
            icon={RiCloseCircleLine}
            media="circle"
            title={appConfig.isChannel ? 'Link Failed' : 'Authorization Failed'}
            description={message}
            action={
              message.includes('expired')
                ? { label: 'Request New Link', onPress: requestNewLink }
                : { label: 'Try Again', onPress: retry }
            }
          />
        )}
      </AuthContainer>
    </>
  );
}
