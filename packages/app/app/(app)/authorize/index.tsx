import React, { useState, useEffect, useCallback } from 'react';
import { View, ActivityIndicator, Linking, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { AuthContainer, AuthLogo } from '@/components/auth';
import { useAuth, useOxy } from '@oxyhq/services';
import apiClient, { getSocketToken } from '@/lib/api/client';
import config from '@/lib/config';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { Separator } from '@/components/ui/separator';
import { io as socketIO } from 'socket.io-client';
import { useTranslation } from '@/hooks/useTranslation';
import { useColorScheme } from '@/lib/useColorScheme';

type AppType = string;
type Status = 'loading' | 'authorize' | 'authorizing' | 'success' | 'error' | 'needLogin';

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
  return APP_CONFIGS[app] || {
    name: app,
    displayName: app.charAt(0).toUpperCase() + app.slice(1),
    permissionKeys: ['linkAccount', 'sendVia'],
    isChannel: true,
  };
}

export default function AuthorizeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { isAuthenticated: isOxyAuth } = useOxy();
  const { t } = useTranslation();
  const { colors } = useColorScheme();

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
    } catch (error: any) {
      console.error('Authorization error:', error);
      setStatus('error');
      setMessage(error.response?.data?.error || t('authorize.failedToAuthorize'));
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
      const res = await apiClient.get(`/bots/internal/${channelType}/check-token/${token}`);
      if (!res.data?.valid) {
        setStatus('error');
        setMessage(res.data?.error || t('authorize.tokenExpired'));
        return;
      }
    } catch (e: any) {
      setStatus('error');
      setMessage(t('authorize.invalidOrExpiredToken'));
      return;
    }

    if (!isOxyAuth) {
      setStatus('needLogin');
      setMessage(t('authorize.needLogin', { app: appConfig.displayName }));
      setTimeout(() => {
        const returnTo = `/authorize?app=${channelType}&token=${token}&channel=${channelType}`;
        router.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
      }, 1500);
      return;
    }

    // Link via bot platform route
    try {
      const response = await apiClient.post(`/bots/platform/${channelType}/link`, {
        authToken: token,
      });
      if (response.data.success) {
        setStatus('success');
        setMessage(t('authorize.linkSuccess', { app: appConfig.displayName }));
      } else {
        setStatus('error');
        setMessage(t('authorize.failedToLink'));
      }
    } catch (error: any) {
      console.error('Bot link error:', error);
      const errorMessage = error.response?.data?.error || t('authorize.failedToLink');
      setStatus('error');
      setMessage(errorMessage);
    }
  }, [params, isOxyAuth, router, channel, app, appConfig.displayName]);

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
        const urlParams = new URLSearchParams();
        Object.entries(params).forEach(([key, value]) => {
          if (value) urlParams.set(key, value as string);
        });
        const returnTo = `/authorize?${urlParams.toString()}`;
        router.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
        return;
      }
      setStatus('authorize');
    }
  }, [isAuthenticated, authLoading, app, channel, params, router, handleChannelAuth, appConfig.isChannel]);

  // Real-time socket subscription for Telegram token linking
  useEffect(() => {
    const token = params.token as string | undefined;
    if (app !== 'telegram' || !token) return;

    // The user is already authenticated on the authorize screen (the layout
    // redirects to /login otherwise), so the connection carries the Oxy bearer
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
        <View className="items-center py-8">
          <ActivityIndicator size="large" color={colors.primary} />
          <Text className="text-muted-foreground mt-4">{t('common.loading')}</Text>
        </View>
      </AuthContainer>
    );
  }

  return (
    <>
      <Head>
        <title>{t('authorize.authorizeApp', { app: appConfig.displayName })}</title>
        <meta name="description" content={t('authorize.appWantsAccess', { app: appConfig.displayName })} />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <AuthContainer>
        <AuthLogo />

        {status === 'authorize' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-center">{t('authorize.authorizeApp', { app: appConfig.displayName })}</CardTitle>
              <CardDescription className="text-center">
                {t('authorize.appWantsAccess', { app: appConfig.displayName })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <View className="gap-4">
                <View className="gap-2">
                  <Text className="text-sm text-muted-foreground font-medium">
                    {t('authorize.willAllow', { app: appConfig.displayName })}
                  </Text>
                  <View className="gap-2 pl-1">
                    {appConfig.permissionKeys.map((key, index) => (
                      <Text key={index} className="text-sm">
                        • {t(`authorize.${key}`, { app: appConfig.displayName })}
                      </Text>
                    ))}
                  </View>
                </View>

                <Separator className="my-2" />

                <View className="gap-3">
                  <Button onPress={handleOAuthAuthorize} size="lg">
                    <Text>{t('common.authorize')}</Text>
                  </Button>

                  <Button onPress={handleCancel} variant="outline" size="lg">
                    <Text>{t('common.cancel')}</Text>
                  </Button>
                </View>
              </View>
            </CardContent>
          </Card>
        )}

        {status === 'authorizing' && (
          <Card>
            <CardContent>
              <View className="items-center py-4 gap-3">
                <ActivityIndicator size="large" color={colors.primary} />
                <Text className="text-xl font-semibold text-foreground">
                  {appConfig.isChannel ? t('authorize.linkingAccount') : t('authorize.authorizing')}
                </Text>
                <Text className="text-muted-foreground text-center">
                  {t('authorize.pleaseWait')}
                </Text>
              </View>
            </CardContent>
          </Card>
        )}

        {status === 'needLogin' && (
          <Card>
            <CardContent>
              <View className="items-center py-4 gap-3">
                <Text className="text-4xl">🔐</Text>
                <View className="gap-2 items-center">
                  <Text className="text-xl font-semibold text-foreground">
                    {t('authorize.authRequired')}
                  </Text>
                  <Text className="text-muted-foreground text-center">
                    {message}
                  </Text>
                  <Text className="text-sm text-muted-foreground text-center">
                    {t('authorize.redirectingToLogin')}
                  </Text>
                </View>
              </View>
            </CardContent>
          </Card>
        )}

        {status === 'success' && (
          <Card>
            <CardContent>
              <View className="items-center py-4 gap-4">
                <Text className="text-4xl">✅</Text>
                <View className="gap-2 items-center">
                  <Text className="text-xl font-semibold text-foreground">
                    {appConfig.isChannel ? t('authorize.linked') : t('authorize.authorized')}
                  </Text>
                  <Text className="text-muted-foreground text-center">
                    {message}
                  </Text>
                </View>
                {redirectUrl ? (
                  <>
                    <Button
                      onPress={() => {
                        if (Platform.OS === 'web') {
                          const link = document.createElement('a');
                          link.href = redirectUrl;
                          link.click();
                        } else {
                          Linking.openURL(redirectUrl);
                        }
                      }}
                      size="lg"
                    >
                      <Text>{t('authorize.openAppManually')}</Text>
                    </Button>
                    <Text className="text-xs text-muted-foreground text-center select-all">
                      {redirectUrl}
                    </Text>
                  </>
                ) : appConfig.isChannel ? (
                  <Text className="text-xs text-muted-foreground text-center">
                    You can now return to {appConfig.displayName} and start chatting with Alia!
                  </Text>
                ) : (
                  <Text className="text-xs text-muted-foreground text-center">
                    If not redirected automatically, you can close this window.
                  </Text>
                )}
              </View>
            </CardContent>
          </Card>
        )}

        {status === 'error' && (
          <Card>
            <CardContent>
              <View className="items-center py-4 gap-4">
                <Text className="text-4xl">❌</Text>
                <View className="gap-2 items-center">
                  <Text className="text-xl font-semibold text-foreground">
                    {appConfig.isChannel ? 'Link Failed' : 'Authorization Failed'}
                  </Text>
                  <Text className="text-muted-foreground text-center">
                    {message}
                  </Text>
                </View>
                {message.includes('expired') ? (
                  <Button
                    onPress={() => {
                      const botUsername = process.env.EXPO_PUBLIC_TELEGRAM_BOT_USERNAME || 'alia_onlbot';
                      const botUrl = `https://t.me/${botUsername}?start=link`;
                      if (Platform.OS === 'web') {
                        window.open(botUrl, '_blank');
                      } else {
                        Linking.openURL(botUrl);
                      }
                    }}
                    size="lg"
                  >
                    <Text>Request New Link</Text>
                  </Button>
                ) : (
                  <Button
                    onPress={() => {
                      if (appConfig.isChannel || channel) {
                        handleChannelAuth();
                      } else {
                        setStatus('authorize');
                      }
                    }}
                    size="lg"
                  >
                    <Text>Try Again</Text>
                  </Button>
                )}
              </View>
            </CardContent>
          </Card>
        )}
      </AuthContainer>
    </>
  );
}
