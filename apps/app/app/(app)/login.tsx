import React, { useState, useEffect, useRef } from 'react';
import { View, Text, Alert, Platform, Pressable, Linking } from 'react-native';
import { useRouter, Link, useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { AuthContainer, AuthLogo, AuthInput, AuthButton, AuthError } from '@/components/auth';
import { Button } from '@/components/ui/button';
import GoogleLogo from '../../assets/socialLogos/google-logo.svg';
import MicrosoftLogo from '../../assets/socialLogos/microsoft-logo.svg';
import AppleLogo from '../../assets/socialLogos/apple-logo.svg';
import TelegramLogo from '../../assets/socialLogos/telegram-logo.svg';


import { toast } from '@/components/sonner';
import apiClient from '@/lib/api/client';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useTranslation } from '@/hooks/useTranslation';

export default function LoginScreen() {
  const router = useRouter();
  const { returnTo } = useLocalSearchParams();
  const login = useAuthStore((state) => state.login);
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [telegramLoading, setTelegramLoading] = useState(false);
  const pollIntervalRef = useRef<any>(null);

  const handleLogin = async () => {
    setError('');

    if (!email.trim()) {
      const errorMsg = t('errors.emailRequired');
      setError(errorMsg);
      if (Platform.OS !== 'web') {
        Alert.alert(t('errors.loginError'), errorMsg);
      }
      return;
    }

    if (!password.trim()) {
      const errorMsg = t('errors.passwordRequired');
      setError(errorMsg);
      if (Platform.OS !== 'web') {
        Alert.alert(t('errors.loginError'), errorMsg);
      }
      return;
    }

    setLoading(true);

    try {
      // Call API login endpoint
      const response = await apiClient.post('/auth/login', {
        email: email.trim(),
        password,
      });

      const { user, token } = response.data;

      // Store user and token in auth store
      login(user, token);

      // Navigate to returnTo URL if provided, otherwise home screen
      if (returnTo && typeof returnTo === 'string') {
        router.replace(returnTo as any);
      } else {
        router.replace('/');
      }
    } catch (error: any) {
      console.error('Login error:', error);
      const errorMessage = error.response?.data?.error || t('errors.failedToLogin');
      setError(errorMessage);

      if (Platform.OS !== 'web') {
        Alert.alert(t('errors.loginFailed'), errorMessage);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSocialLogin = (provider: string) => {
    const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
    toast.info(t('errors.socialLoginSoon', { provider: providerName }));
  };

  const handleTelegramSignIn = async () => {
    setError('');
    setTelegramLoading(true);

    try {
      // Initiate Telegram sign-in flow
      const response = await apiClient.post('/auth/telegram/initiate');
      const { authCode, deepLink } = response.data;

      // Open Telegram app with deep link
      const canOpen = await Linking.canOpenURL(deepLink);
      if (canOpen) {
        await Linking.openURL(deepLink);

        // Start polling for completion
        toast.info('Waiting for Telegram authentication...');
        startPolling(authCode);
      } else {
        toast.error('Unable to open Telegram. Please make sure it is installed.');
        setTelegramLoading(false);
      }
    } catch (error: any) {
      console.error('Telegram sign-in error:', error);
      const errorMessage = error.response?.data?.error || 'Failed to initiate Telegram sign-in';
      setError(errorMessage);
      setTelegramLoading(false);

      if (Platform.OS !== 'web') {
        Alert.alert('Telegram Sign-In Failed', errorMessage);
      }
    }
  };

  const startPolling = (authCode: string) => {
    // Clear any existing polling
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    let attempts = 0;
    const maxAttempts = 60; // Poll for 2 minutes (2 seconds * 60)

    pollIntervalRef.current = setInterval(async () => {
      attempts++;

      if (attempts > maxAttempts) {
        // Timeout
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
        }
        setTelegramLoading(false);
        toast.error('Telegram sign-in timed out. Please try again.');
        return;
      }

      try {
        const response = await apiClient.get(`/auth/telegram/poll/${authCode}`);
        const { status, token } = response.data;

        if (status === 'completed' && token) {
          // Sign-in complete!
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
          }

          // Get user data with the token
          const userResponse = await apiClient.get('/auth/me', {
            headers: { Authorization: `Bearer ${token}` },
          });

          const userData = userResponse.data.user || userResponse.data;

          // Store user and token in auth store
          login(userData, token);

          setTelegramLoading(false);
          toast.success('Signed in successfully with Telegram!');

          // Navigate to returnTo URL if provided, otherwise home screen
          if (returnTo && typeof returnTo === 'string') {
            router.replace(returnTo as any);
          } else {
            router.replace('/');
          }
        } else if (status === 'expired') {
          // Auth code expired
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
          }
          setTelegramLoading(false);
          toast.error('Telegram sign-in expired. Please try again.');
        }
        // Otherwise keep polling (status === 'pending')
      } catch (error) {
        console.error('Polling error:', error);
        // Continue polling even on error (might be temporary network issue)
      }
    }, 2000); // Poll every 2 seconds
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  return (
    <>
      <Head>
        <title>Log in to Alia</title>
        <meta name="description" content="Log in to Alia to access your AI assistant. Get instant answers and boost your productivity." />
        <link rel="canonical" href="https://alia.onl/login" />
      </Head>
      <AuthContainer>
        <AuthLogo />

        {/* Header */}
        <View className="space-y-2 mb-6">
          <Text className="text-3xl font-bold text-foreground tracking-tight">
            {t('login.title')}
          </Text>
          <Text className="text-base text-muted-foreground">
            {t('login.subtitle')}
          </Text>
        </View>

        {/* Social Login Buttons */}
        <View className="gap-2 mb-4">
          <Button
            variant="outline"
            onPress={() => handleSocialLogin('google')}
            className="h-11 rounded-full"
          >
            <View className="flex-row items-center gap-2">
              <GoogleLogo width={22} height={22} />
              <Text className="text-sm font-medium">{t('login.continueWithGoogle')}</Text>
            </View>
          </Button>

          <Button
            variant="outline"
            onPress={handleTelegramSignIn}
            disabled={telegramLoading}
            className="h-11 rounded-full"
          >
            <View className="flex-row items-center gap-2">
              <TelegramLogo width={22} height={22} />
              <Text className="text-sm font-medium">
                {telegramLoading ? 'Waiting for Telegram...' : t('login.continueWithTelegram')}
              </Text>
            </View>
          </Button>
        </View>

        {/* Divider */}
        <View className="flex-row items-center gap-3 mb-4">
          <View className="flex-1 h-px bg-border" />
          <Text className="text-sm text-muted-foreground">{t('common.or')}</Text>
          <View className="flex-1 h-px bg-border" />
        </View>

        {/* Login Form */}
        <View className="gap-3">
          <AuthError message={error} />

          <AuthInput
            placeholder={t('login.emailPlaceholder')}
            value={email}
            onChangeText={(text) => {
              setEmail(text);
              setError('');
            }}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            editable={!loading}
          />

          <AuthInput
            placeholder={t('login.passwordPlaceholder')}
            value={password}
            onChangeText={(text) => {
              setPassword(text);
              setError('');
            }}
            secureTextEntry
            editable={!loading}
            onSubmitEditing={handleLogin}
          />

          <View className="flex-row justify-end">
            <Link href="/forgot-password" asChild>
              <Pressable>
                <Text className="text-primary text-sm font-medium">{t('login.forgotPassword')}</Text>
              </Pressable>
            </Link>
          </View>

          <AuthButton
            onPress={handleLogin}
            disabled={loading || !email || !password}
            isLoading={loading}
            loadingText={t('login.signingIn')}
          >
            {t('login.signInButton')}
          </AuthButton>
        </View>

        {/* Footer */}
        <View className="mt-6">
          <View className="flex-row items-center justify-center gap-1">
            <Text className="text-muted-foreground text-sm">
              {t('login.footerText')}
            </Text>
            <Link href="/register" asChild>
              <Pressable>
                <Text className="text-primary text-sm font-medium">{t('login.footerLink')}</Text>
              </Pressable>
            </Link>
          </View>
        </View>

        {/* Privacy note */}
        <View className="mt-8">
          <Text className="text-xs text-muted-foreground text-center leading-4">
            {t('login.termsAndPrivacy')}
          </Text>
        </View>
      </AuthContainer>
    </>
  );
}
