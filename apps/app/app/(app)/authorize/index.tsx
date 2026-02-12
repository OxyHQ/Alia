import React, { useState, useEffect, useCallback } from 'react';
import { View, ActivityIndicator, Linking, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { AuthContainer, AuthLogo } from '@/components/auth';
import { useAuth, useOxy } from '@oxyhq/services';
import apiClient from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { Separator } from '@/components/ui/separator';

type AppType = string;
type Status = 'loading' | 'authorize' | 'authorizing' | 'success' | 'error' | 'needLogin';

interface AppConfig {
  name: string;
  displayName: string;
  permissions: string[];
  isChannel?: boolean;
}

const APP_CONFIGS: Record<string, AppConfig> = {
  codea: {
    name: 'codea',
    displayName: 'Alia Codea',
    permissions: [
      'Send messages to AI models',
      'Use your credits for API calls',
      'Access available models',
    ],
  },
  cowork: {
    name: 'cowork',
    displayName: 'Alia Cowork',
    permissions: [
      'Send messages to AI models',
      'Use your credits for API calls',
      'Access available models',
    ],
  },
  telegram: {
    name: 'telegram',
    displayName: 'Telegram',
    permissions: [
      'Link your Telegram account',
      'Send messages via Telegram',
      'Receive notifications',
    ],
    isChannel: true,
  },
  discord: {
    name: 'discord',
    displayName: 'Discord',
    permissions: [
      'Link your Discord account',
      'Send messages via Discord',
      'Receive notifications',
    ],
    isChannel: true,
  },
};

function getAppConfig(app: string): AppConfig {
  return APP_CONFIGS[app] || {
    name: app,
    displayName: app.charAt(0).toUpperCase() + app.slice(1),
    permissions: [
      `Link your ${app} account`,
      `Send messages via ${app}`,
    ],
    isChannel: true,
  };
}

export default function AuthorizeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { isAuthenticated: isOxyAuth } = useOxy();

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
      setMessage('Invalid callback URL. Please try again from the app.');
      return;
    }

    if (!code_challenge || typeof code_challenge !== 'string') {
      setStatus('error');
      setMessage('Invalid authorization request. Missing PKCE challenge.');
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
      setMessage('Authorization successful! Redirecting back to the app...');

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
      setMessage(error.response?.data?.error || 'Failed to authorize. Please try again.');
    }
  };

  // Handle Telegram link flow (legacy /telegram/* endpoints)
  const handleTelegramAuth = useCallback(async () => {
    const { token } = params;

    setStatus('authorizing');

    if (!token || typeof token !== 'string') {
      setStatus('error');
      setMessage('Invalid authentication token. The link you followed is not valid.');
      return;
    }

    let tokenMode: 'signin' | 'link' | null = null;
    let tgUser: any = null;

    try {
      const res = await apiClient.get(`/telegram/users/token/${token}`);
      tokenMode = res.data?.authTokenMode || null;
      tgUser = res.data;
    } catch (e: any) {
      setStatus('error');
      const errorMsg = e.response?.data?.error || 'Invalid or expired token';
      setMessage(errorMsg);
      return;
    }

    if (tokenMode === 'link') {
      if (isOxyAuth) {
        try {
          const response = await apiClient.post('/telegram/link', {
            authToken: token,
          });
          if (response.data.success) {
            setStatus('success');
            setMessage('Your Telegram account has been linked successfully!');
          } else {
            setStatus('error');
            setMessage('Failed to link your account. Please try again.');
          }
        } catch (error: any) {
          console.error('Link error:', error);
          const errorMessage = error.response?.data?.error || 'Failed to link account';
          setStatus('error');
          setMessage(errorMessage);
        }
      } else {
        setStatus('needLogin');
        setMessage('You need to log in first to link your Telegram account.');
        setTimeout(() => {
          router.replace(`/login?returnTo=/authorize?app=telegram&token=${token}`);
        }, 1500);
      }
      return;
    }

    if (tokenMode === 'signin') {
      if (tgUser && tgUser.oxyUserId) {
        setStatus('success');
        setMessage('Redirecting to complete sign in...');
        setTimeout(() => {
          router.replace('/login');
        }, 1200);
      } else {
        setStatus('error');
        setMessage('This Telegram account is not linked to any Oxy account yet. Please create an Oxy account and link your Telegram from the settings.');
      }
      return;
    }

    setStatus('error');
    setMessage('Invalid token mode. Please request a new link from the Telegram bot.');
  }, [params, isOxyAuth, router, app]);

  // Handle generic channel link flow (uses /channels/{type}/* endpoints)
  const handleChannelAuth = useCallback(async () => {
    const { token } = params;
    const channelType = channel || app;

    setStatus('authorizing');

    if (!token || typeof token !== 'string') {
      setStatus('error');
      setMessage('Invalid authentication token. The link you followed is not valid.');
      return;
    }

    // Verify token is valid
    try {
      const res = await apiClient.get(`/channels/${channelType}/check-token/${token}`);
      if (!res.data?.valid) {
        setStatus('error');
        setMessage(res.data?.error || 'This link has expired. Please request a new one.');
        return;
      }
    } catch (e: any) {
      setStatus('error');
      setMessage('Invalid or expired token. Please request a new link.');
      return;
    }

    if (!isOxyAuth) {
      setStatus('needLogin');
      setMessage(`You need to log in first to link your ${appConfig.displayName} account.`);
      setTimeout(() => {
        const returnTo = `/authorize?app=${channelType}&token=${token}&channel=${channelType}`;
        router.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
      }, 1500);
      return;
    }

    // Link the channel account
    try {
      const response = await apiClient.post(`/channels/${channelType}/link`, {
        authToken: token,
      });
      if (response.data.success) {
        setStatus('success');
        setMessage(`Your ${appConfig.displayName} account has been linked successfully!`);
      } else {
        setStatus('error');
        setMessage('Failed to link your account. Please try again.');
      }
    } catch (error: any) {
      console.error('Channel link error:', error);
      const errorMessage = error.response?.data?.error || 'Failed to link account';
      setStatus('error');
      setMessage(errorMessage);
    }
  }, [params, isOxyAuth, router, channel, app, appConfig.displayName]);

  useEffect(() => {
    if (authLoading) return;

    if (app === 'telegram' && !channel) {
      // Legacy Telegram flow using /telegram/* endpoints
      if (params.token) {
        handleTelegramAuth();
      } else {
        setStatus('error');
        setMessage('Missing authentication token.');
      }
    } else if (appConfig.isChannel || channel) {
      // Generic channel flow (Discord, etc.) using /channels/{type}/* endpoints
      if (params.token) {
        handleChannelAuth();
      } else {
        setStatus('error');
        setMessage('Missing authentication token.');
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
  }, [isAuthenticated, authLoading, app, channel, params, router, handleTelegramAuth, handleChannelAuth, appConfig.isChannel]);

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
          <ActivityIndicator size="large" color="#667eea" />
          <Text className="text-muted-foreground mt-4">Loading...</Text>
        </View>
      </AuthContainer>
    );
  }

  return (
    <>
      <Head>
        <title>Authorize {appConfig.displayName}</title>
        <meta name="description" content={`Authorize ${appConfig.displayName} to access your account`} />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <AuthContainer>
        <AuthLogo />

        {status === 'authorize' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-center">Authorize {appConfig.displayName}</CardTitle>
              <CardDescription className="text-center">
                {appConfig.displayName} wants to access your account
              </CardDescription>
            </CardHeader>
            <CardContent>
              <View className="gap-4">
                <View className="gap-2">
                  <Text className="text-sm text-muted-foreground font-medium">
                    This will allow {appConfig.displayName} to:
                  </Text>
                  <View className="gap-2 pl-1">
                    {appConfig.permissions.map((permission, index) => (
                      <Text key={index} className="text-sm">
                        • {permission}
                      </Text>
                    ))}
                  </View>
                </View>

                <Separator className="my-2" />

                <View className="gap-3">
                  <Button onPress={handleOAuthAuthorize} size="lg">
                    <Text>Authorize</Text>
                  </Button>

                  <Button onPress={handleCancel} variant="outline" size="lg">
                    <Text>Cancel</Text>
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
                <ActivityIndicator size="large" color="#667eea" />
                <Text className="text-xl font-semibold text-foreground">
                  {appConfig.isChannel ? 'Linking account...' : 'Authorizing...'}
                </Text>
                <Text className="text-muted-foreground text-center">
                  Please wait while we set up your access
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
                    Authentication Required
                  </Text>
                  <Text className="text-muted-foreground text-center">
                    {message}
                  </Text>
                  <Text className="text-sm text-muted-foreground text-center">
                    Redirecting to login...
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
                    {appConfig.isChannel ? 'Linked!' : 'Authorized!'}
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
                      <Text>Open App Manually</Text>
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
                <Button
                  onPress={() => {
                    if (app === 'telegram' && !channel) {
                      handleTelegramAuth();
                    } else if (appConfig.isChannel || channel) {
                      handleChannelAuth();
                    } else {
                      setStatus('authorize');
                    }
                  }}
                  size="lg"
                >
                  <Text>Try Again</Text>
                </Button>
              </View>
            </CardContent>
          </Card>
        )}
      </AuthContainer>
    </>
  );
}
