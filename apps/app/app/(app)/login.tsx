import React from 'react';
import { View, Text } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { AuthContainer, AuthLogo } from '@/components/auth';
import { OxySignInButton } from '@oxyhq/services';
import { useAuth } from '@oxyhq/services';
import { useEffect } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { SEOHead } from '@/components/seo/SEOHead';
import { META_PRESETS } from '@/lib/seo/meta-tags';

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
      <SEOHead {...META_PRESETS.login} />
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
