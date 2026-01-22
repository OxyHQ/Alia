import React, { useEffect } from 'react';
import { View, Text } from 'react-native';
import { useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { AuthContainer, AuthLogo } from '@/components/auth';
import { OxySignInButton } from '@oxyhq/services';
import { useAuth } from '@oxyhq/services';
import { useTranslation } from '@/hooks/useTranslation';

export default function RegisterScreen() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();
  const { t } = useTranslation();

  // Redirect to home if already authenticated
  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      router.replace('/');
    }
  }, [isAuthenticated, isLoading, router]);

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
        <title>Create Account - Alia</title>
        <meta name="description" content="Create your Alia account to access your AI assistant." />
      </Head>
      <AuthContainer>
        <AuthLogo />

        {/* Header */}
        <View className="space-y-2 mb-6">
          <Text className="text-3xl font-bold text-foreground tracking-tight">
            {t('register.title')}
          </Text>
          <Text className="text-base text-muted-foreground">
            {t('register.subtitle')}
          </Text>
        </View>

        {/* Oxy Sign In Button - handles both sign in and registration */}
        <View className="gap-4">
          <OxySignInButton />
        </View>

        {/* Privacy note */}
        <View className="mt-8">
          <Text className="text-xs text-muted-foreground text-center leading-4">
            {t('register.termsAndPrivacy')}
          </Text>
        </View>
      </AuthContainer>
    </>
  );
}
