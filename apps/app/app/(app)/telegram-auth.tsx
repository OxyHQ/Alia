import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { AuthContainer, AuthLogo } from '@/components/auth';
import { useAuthStore } from '@/lib/stores/auth-store';
import apiClient from '@/lib/api/client';

export default function TelegramAuthScreen() {
  const router = useRouter();
  const { token } = useLocalSearchParams();
  const authToken = useAuthStore((state) => state.token);
  const user = useAuthStore((state) => state.user);
  const [status, setStatus] = useState<'checking' | 'success' | 'error' | 'needLogin'>('checking');
  const [message, setMessage] = useState('');

  useEffect(() => {
    async function linkAccount() {
      if (!token || typeof token !== 'string') {
        setStatus('error');
        setMessage('Invalid authentication token');
        return;
      }

      try {
        // Check if user is already logged in
        if (!authToken || !user) {
          // User not logged in - redirect to login with return URL
          setStatus('needLogin');
          setMessage('Please log in to continue');
          setTimeout(() => {
            router.replace(`/login?returnTo=/telegram-auth?token=${token}`);
          }, 1500);
          return;
        }

        // User is logged in - link the Telegram account
        const response = await apiClient.post('/telegram/link', {
          authToken: token,
          sessionToken: authToken,
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
    }

    linkAccount();
  }, [token, authToken, user, router]);

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
                Error
              </Text>
            </View>
            <Text className="text-base text-muted-foreground text-center">
              {message}
            </Text>
            <Text className="text-sm text-muted-foreground text-center">
              Please try again or request a new link from the Telegram bot.
            </Text>
          </>
        )}
      </View>
    </AuthContainer>
  );
}
