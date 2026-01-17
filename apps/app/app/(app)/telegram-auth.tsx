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
    async function handleTelegramAuth() {
      if (!token || typeof token !== 'string') {
        setStatus('error');
        setMessage('Invalid authentication token');
        return;
      }

      // Consultar el modo del token (login o vinculación)
      let tokenMode: 'signin' | 'link' | null = null;
      let tgUser: any = null;
      try {
        const res = await apiClient.get(`/telegram/users/token/${token}`); // Nuevo endpoint sugerido para obtener info del token
        tokenMode = res.data?.authTokenMode || null;
        tgUser = res.data;
      } catch (e) {
        setStatus('error');
        setMessage('Invalid or expired token. Please request a new link from Telegram.');
        return;
      }

      if (tokenMode === 'link') {
        // Solo permitir vinculación si hay sesión
        if (authToken && user) {
          try {
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
        } else {
          setStatus('needLogin');
          setMessage('Please log in to your Alia account to link Telegram.');
          setTimeout(() => {
            router.replace(`/login?returnTo=/telegram-auth?token=${token}`);
          }, 1500);
        }
        return;
      }

      if (tokenMode === 'signin') {
        // Solo permitir login automático con Telegram
        if (tgUser && tgUser.userId && tgUser.sessionToken) {
          useAuthStore.getState().login(
            {
              id: tgUser.userId,
              email: tgUser.email || '',
              name: tgUser.name || '',
            },
            tgUser.sessionToken
          );
          setStatus('success');
          setMessage('Logged in with your Telegram account!');
          setTimeout(() => {
            router.replace('/');
          }, 1200);
        } else {
          setStatus('error');
          setMessage('This Telegram is not linked to any Alia account. Please create an account or request a new link.');
        }
        return;
      }
      setStatus('error');
      setMessage('Invalid or expired token. Please request a new link from Telegram.');
    }
    handleTelegramAuth();
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
