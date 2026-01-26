import React, { useState, useEffect } from 'react';
import { View, ActivityIndicator, Linking, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { AuthContainer, AuthLogo } from '@/components/auth';
import { useAuth } from '@oxyhq/services';
import apiClient from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { Separator } from '@/components/ui/separator';

export default function AuthorizeCodeaScreen() {
  const router = useRouter();
  const { callback, code_challenge, code_challenge_method } = useLocalSearchParams();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [status, setStatus] = useState<'loading' | 'authorize' | 'authorizing' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [redirectUrl, setRedirectUrl] = useState('');

  useEffect(() => {
    if (authLoading) return;

    if (!isAuthenticated) {
      // Redirect to login with return URL, preserving PKCE params
      const params = new URLSearchParams();
      if (callback) params.set('callback', callback as string);
      if (code_challenge) params.set('code_challenge', code_challenge as string);
      if (code_challenge_method) params.set('code_challenge_method', code_challenge_method as string);
      const returnTo = `/authorize/codea?${params.toString()}`;
      router.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }

    // User is authenticated, show authorization screen
    setStatus('authorize');
  }, [isAuthenticated, authLoading, callback, code_challenge, code_challenge_method, router]);

  const handleAuthorize = async () => {
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
      // Call API to authorize with PKCE
      const response = await apiClient.post('/auth/authorize/codea', {
        code_challenge,
        code_challenge_method: code_challenge_method || 'S256',
      });
      const { code } = response.data;

      if (!code) {
        throw new Error('No authorization code received');
      }

      // Build callback URL with code
      const callbackUrl = new URL(callback);
      callbackUrl.searchParams.set('code', code);
      const finalUrl = callbackUrl.toString();

      console.log('Redirecting to:', finalUrl);
      setRedirectUrl(finalUrl);
      setStatus('success');
      setMessage('Authorization successful! Redirecting back to the app...');

      // Redirect to callback with authorization code
      // Use replace to avoid back button issues, with fallback
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

  const handleCancel = () => {
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
        <title>Authorize Alia Cowork</title>
        <meta name="description" content="Authorize Alia Cowork to access your account" />
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <AuthContainer>
        <AuthLogo />

        {status === 'authorize' && (
          <View className="w-full max-w-md gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-center">Authorize Alia Cowork</CardTitle>
                <CardDescription className="text-center">
                  Alia Cowork wants to access your account
                </CardDescription>
              </CardHeader>
              <CardContent className="gap-4">
                <View className="gap-2">
                  <Text className="text-sm text-muted-foreground font-medium">
                    This will allow Alia Cowork to:
                  </Text>
                  <View className="gap-2 pl-1">
                    <Text className="text-sm">• Send messages to AI models</Text>
                    <Text className="text-sm">• Use your credits for API calls</Text>
                    <Text className="text-sm">• Access available models</Text>
                  </View>
                </View>

                <Separator className="my-2" />

                <View className="gap-3">
                  <Button onPress={handleAuthorize} size="lg">
                    <Text>Authorize</Text>
                  </Button>

                  <Button onPress={handleCancel} variant="outline" size="lg">
                    <Text>Cancel</Text>
                  </Button>
                </View>
              </CardContent>
            </Card>
          </View>
        )}

        {status === 'authorizing' && (
          <Card>
            <CardContent>
              <View className="items-center py-4 gap-3">
                <ActivityIndicator size="large" color="#667eea" />
                <Text className="text-xl font-semibold text-foreground">
                  Authorizing...
                </Text>
                <Text className="text-muted-foreground text-center">
                  Please wait while we set up your access
                </Text>
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
                    Authorized!
                  </Text>
                  <Text className="text-muted-foreground text-center">
                    {message}
                  </Text>
                </View>
                {redirectUrl ? (
                  <>
                    <Button
                      onPress={() => {
                        console.log('Manual redirect to:', redirectUrl);
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
                    Authorization Failed
                  </Text>
                  <Text className="text-muted-foreground text-center">
                    {message}
                  </Text>
                </View>
                <Button
                  onPress={() => setStatus('authorize')}
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
