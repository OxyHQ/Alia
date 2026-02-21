import React from 'react';
import { View, Text, Linking } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';
import { AuthContainer, AuthLogo } from '@/components/auth';
import { OxySignInButton } from '@oxyhq/services';
import { useAuth } from '@oxyhq/services';
import { useEffect } from 'react';
import { useTranslation } from '@/hooks/useTranslation';

export default function LoginScreen() {
  const router = useRouter();
  const { returnTo } = useLocalSearchParams();
  const { isAuthenticated, isLoading } = useAuth();
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
        <title>Login</title>
        <meta name="description" content="Sign in to Alia" />
        <meta name="robots" content="noindex, nofollow" />
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
            {t('login.termsPrefix')}
            <Text
              className="text-xs text-foreground underline"
              onPress={() => Linking.openURL('https://oxy.so/company/transparency/policies/terms-of-service')}
            >
              {t('login.termsOfService')}
            </Text>
            {t('login.termsAnd')}
            <Text
              className="text-xs text-foreground underline"
              onPress={() => Linking.openURL('https://oxy.so/company/transparency/policies/privacy')}
            >
              {t('login.privacyPolicy')}
            </Text>
          </Text>
        </View>
      </AuthContainer>
    </>
  );
}
