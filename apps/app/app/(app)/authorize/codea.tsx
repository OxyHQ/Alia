import React, { useState, useEffect } from 'react';
import { View, Text, ActivityIndicator, TouchableOpacity } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { AuthContainer, AuthLogo } from '@/components/auth';
import { useOxy } from '@oxyhq/services';
import apiClient from '@/lib/api/client';

export default function AuthorizeCodeaScreen() {
  const router = useRouter();
  const { callback } = useLocalSearchParams();
  const { isAuthenticated, isLoading: authLoading } = useOxy();
  const [status, setStatus] = useState<'loading' | 'authorize' | 'authorizing' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (authLoading) return;

    if (!isAuthenticated) {
      // Redirect to login with return URL
      const returnTo = `/authorize/codea?callback=${encodeURIComponent(callback as string || '')}`;
      router.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }

    // User is authenticated, show authorization screen
    setStatus('authorize');
  }, [isAuthenticated, authLoading, callback, router]);

  const handleAuthorize = async () => {
    if (!callback || typeof callback !== 'string') {
      setStatus('error');
      setMessage('Invalid callback URL. Please try again from the app.');
      return;
    }

    setStatus('authorizing');

    try {
      // Call API to create/get API key for Alia Cowork
      const response = await apiClient.post('/auth/authorize/codea');
      const { token } = response.data;

      if (!token) {
        throw new Error('No token received');
      }

      setStatus('success');
      setMessage('Authorization successful! Redirecting back to the app...');

      // Redirect to callback with token
      setTimeout(() => {
        const callbackUrl = new URL(callback);
        callbackUrl.searchParams.set('token', token);
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
      const callbackUrl = new URL(callback);
      callbackUrl.searchParams.set('error', 'user_cancelled');
      window.location.href = callbackUrl.toString();
    } else {
      router.back();
    }
  };

  if (authLoading || status === 'loading') {
    return (
      <AuthContainer>
        <AuthLogo />
        <View className="items-center space-y-4">
          <ActivityIndicator size="large" color="#667eea" />
          <Text className="text-lg text-muted-foreground">Loading...</Text>
        </View>
      </AuthContainer>
    );
  }

  return (
    <AuthContainer>
      <AuthLogo />

      <View className="space-y-6 items-center w-full max-w-sm">
        {status === 'authorize' && (
          <>
            <View className="bg-card p-6 rounded-xl border border-border w-full">
              <Text className="text-2xl font-bold text-foreground text-center mb-2">
                Authorize Alia Cowork
              </Text>
              <Text className="text-base text-muted-foreground text-center mb-6">
                Alia Cowork wants to access your account
              </Text>

              <View className="space-y-3 mb-6">
                <View className="flex-row items-center space-x-3">
                  <Text className="text-lg">✓</Text>
                  <Text className="text-foreground">Send messages to AI models</Text>
                </View>
                <View className="flex-row items-center space-x-3">
                  <Text className="text-lg">✓</Text>
                  <Text className="text-foreground">Use your credits for API calls</Text>
                </View>
                <View className="flex-row items-center space-x-3">
                  <Text className="text-lg">✓</Text>
                  <Text className="text-foreground">Access available models</Text>
                </View>
              </View>

              <TouchableOpacity
                onPress={handleAuthorize}
                className="bg-primary py-3 px-6 rounded-lg mb-3"
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
          <>
            <ActivityIndicator size="large" color="#667eea" />
            <Text className="text-xl font-semibold text-foreground">
              Authorizing...
            </Text>
            <Text className="text-base text-muted-foreground text-center">
              Please wait while we set up your access
            </Text>
          </>
        )}

        {status === 'success' && (
          <>
            <View className="bg-green-100 dark:bg-green-900 p-4 rounded-lg">
              <Text className="text-4xl text-center mb-2">✅</Text>
              <Text className="text-lg font-semibold text-green-900 dark:text-green-100 text-center">
                Authorized!
              </Text>
            </View>
            <Text className="text-base text-muted-foreground text-center">
              {message}
            </Text>
          </>
        )}

        {status === 'error' && (
          <>
            <View className="bg-red-100 dark:bg-red-900 p-4 rounded-lg">
              <Text className="text-4xl text-center mb-2">❌</Text>
              <Text className="text-lg font-semibold text-red-900 dark:text-red-100 text-center">
                Authorization Failed
              </Text>
            </View>
            <Text className="text-base text-foreground text-center font-medium">
              {message}
            </Text>
            <TouchableOpacity
              onPress={() => setStatus('authorize')}
              className="mt-4 bg-primary px-6 py-3 rounded-lg"
            >
              <Text className="text-primary-foreground text-center font-semibold">
                Try Again
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </AuthContainer>
  );
}
