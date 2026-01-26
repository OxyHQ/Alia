import React, { useState, useEffect } from 'react';
import { View, Text, ActivityIndicator, TouchableOpacity } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { AuthContainer, AuthLogo } from '@/components/auth';
import { useAuth } from '@oxyhq/services';
import apiClient from '@/lib/api/client';

export default function AuthorizeCodeaScreen() {
  const router = useRouter();
  const { callback, code_challenge, code_challenge_method } = useLocalSearchParams();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [status, setStatus] = useState<'loading' | 'authorize' | 'authorizing' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');

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

      setStatus('success');
      setMessage('Authorization successful! Redirecting back to the app...');

      // Redirect to callback with authorization code
      setTimeout(() => {
        const callbackUrl = new URL(callback);
        callbackUrl.searchParams.set('code', code);
        window.location.href = callbackUrl.toString();
      }, 1500);
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
          <>
            <View className="space-y-2 mb-6">
              <Text className="text-2xl font-bold text-foreground tracking-tight text-center">
                Authorize Alia Cowork
              </Text>
              <Text className="text-base text-muted-foreground text-center">
                Alia Cowork wants to access your account
              </Text>
            </View>

            <View className="bg-card p-4 rounded-lg border border-border mb-6">
              <Text className="text-sm text-muted-foreground mb-3">This will allow Alia Cowork to:</Text>
              <View className="space-y-2">
                <Text className="text-foreground">• Send messages to AI models</Text>
                <Text className="text-foreground">• Use your credits for API calls</Text>
                <Text className="text-foreground">• Access available models</Text>
              </View>
            </View>

            <View className="gap-3">
              <TouchableOpacity
                onPress={handleAuthorize}
                className="bg-primary py-3 px-6 rounded-lg"
              >
                <Text className="text-primary-foreground text-center font-semibold text-lg">
                  Authorize
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleCancel}
                className="py-3 px-6 rounded-lg border border-border"
              >
                <Text className="text-foreground text-center font-medium">
                  Cancel
                </Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {status === 'authorizing' && (
          <View className="items-center py-8">
            <ActivityIndicator size="large" color="#667eea" />
            <Text className="text-xl font-semibold text-foreground mt-4">
              Authorizing...
            </Text>
            <Text className="text-muted-foreground text-center mt-2">
              Please wait while we set up your access
            </Text>
          </View>
        )}

        {status === 'success' && (
          <View className="items-center py-8">
            <Text className="text-4xl mb-4">✅</Text>
            <Text className="text-xl font-semibold text-foreground">
              Authorized!
            </Text>
            <Text className="text-muted-foreground text-center mt-2">
              {message}
            </Text>
          </View>
        )}

        {status === 'error' && (
          <View className="items-center py-8">
            <Text className="text-4xl mb-4">❌</Text>
            <Text className="text-xl font-semibold text-foreground">
              Authorization Failed
            </Text>
            <Text className="text-muted-foreground text-center mt-2">
              {message}
            </Text>
            <TouchableOpacity
              onPress={() => setStatus('authorize')}
              className="mt-6 bg-primary px-6 py-3 rounded-lg"
            >
              <Text className="text-primary-foreground text-center font-semibold">
                Try Again
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </AuthContainer>
    </>
  );
}
