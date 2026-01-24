import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ActivityIndicator, TouchableOpacity } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { AuthContainer, AuthLogo } from '@/components/auth';
import { useOxy } from '@oxyhq/services';
import apiClient from '@/lib/api/client';

export default function TelegramAuthScreen() {
  const router = useRouter();
  const { token } = useLocalSearchParams();
  const { isAuthenticated } = useOxy();
  const [status, setStatus] = useState<'checking' | 'success' | 'error' | 'needLogin'>('checking');
  const [message, setMessage] = useState('');
  const [retrying, setRetrying] = useState(false);

  const handleTelegramAuth = useCallback(async () => {
    setStatus('checking');
    setRetrying(false);

    if (!token || typeof token !== 'string') {
      setStatus('error');
      setMessage('Invalid authentication token. The link you followed is not valid.');
      return;
    }

    // Get token info to determine mode
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
      // Link mode: requires authenticated session
      if (isAuthenticated) {
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
          router.replace(`/login?returnTo=/telegram-auth?token=${token}`);
        }, 1500);
      }
      return;
    }

    if (tokenMode === 'signin') {
      // Sign-in mode: redirect to login
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
  }, [token, isAuthenticated, router]);

  useEffect(() => {
    handleTelegramAuth();
  }, [handleTelegramAuth]);

  return (
    <AuthContainer>
      <AuthLogo />

      <View className="space-y-6 items-center">
        {status === 'checking' && (
          <>
            <ActivityIndicator size="large" color="#667eea" />
            <Text className="text-xl font-semibold text-foreground">
              Linking your Telegram account...
            </Text>
            <Text className="text-base text-muted-foreground text-center">
              Please wait while we connect your account
            </Text>
          </>
        )}

        {status === 'needLogin' && (
          <>
            <View className="bg-blue-100 dark:bg-blue-900 p-4 rounded-lg">
              <Text className="text-4xl text-center mb-2">🔐</Text>
              <Text className="text-lg font-semibold text-blue-900 dark:text-blue-100 text-center">
                Authentication Required
              </Text>
            </View>
            <Text className="text-base text-muted-foreground text-center">
              {message}
            </Text>
            <Text className="text-sm text-muted-foreground text-center">
              Redirecting to login...
            </Text>
          </>
        )}

        {status === 'success' && (
          <>
            <View className="bg-green-100 dark:bg-green-900 p-4 rounded-lg">
              <Text className="text-4xl text-center mb-2">✅</Text>
              <Text className="text-lg font-semibold text-green-900 dark:text-green-100 text-center">
                Success!
              </Text>
            </View>
            <Text className="text-base text-muted-foreground text-center">
              {message}
            </Text>
            <Text className="text-sm text-muted-foreground text-center">
              You can now return to Telegram and start chatting with Alia!
            </Text>
          </>
        )}

        {status === 'error' && (
          <>
            <View className="bg-red-100 dark:bg-red-900 p-4 rounded-lg">
              <Text className="text-4xl text-center mb-2">❌</Text>
              <Text className="text-lg font-semibold text-red-900 dark:text-red-100 text-center">
                Link Failed
              </Text>
            </View>
            <Text className="text-base text-foreground text-center font-medium">
              {message}
            </Text>
            <Text className="text-sm text-muted-foreground text-center">
              Please request a new link from the Telegram bot and try again.
            </Text>
            <TouchableOpacity
              onPress={() => {
                setRetrying(true);
                handleTelegramAuth();
              }}
              disabled={retrying}
              className="mt-4 bg-blue-600 px-6 py-3 rounded-lg"
            >
              {retrying ? (
                <ActivityIndicator color="white" size="small" />
              ) : (
                <Text className="text-white text-center font-semibold">
                  Try Again
                </Text>
              )}
            </TouchableOpacity>
          </>
        )}
      </View>
    </AuthContainer>
  );
}
