import React from 'react';
import { View, Text } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { AuthContainer, AuthLogo } from '@/components/auth';
import { OxySignInButton, useOxy } from '@oxyhq/services';
import { useEffect } from 'react';
import { useTranslation } from '@/hooks/useTranslation';

export default function LoginScreen() {
  const router = useRouter();
  const { returnTo } = useLocalSearchParams();
  const { isAuthenticated, isLoading } = useOxy();
  const { t } = useTranslation();

  // Redirect to home if already authenticated
  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      if (returnTo && typeof returnTo === 'string') {
        router.replace(returnTo as any);
      } else {
        router.replace('/');
      }
    }
  }, [isAuthenticated, isLoading, returnTo, router]);

  if (isLoading) {
    return (
      <AuthContainer>
        <AuthLogo />
        <View className="items-center justify-center py-8">
          <Text className="text-muted-foreground">{t('common.loading')}</Text>
        </View>
      </AuthContainer>
    );
  }

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

        {/* Oxy Sign In Button */}
        <View className="gap-4">
          <OxySignInButton />
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
