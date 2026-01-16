import React, { useState } from 'react';
import { View, Text, Alert, Platform, Pressable } from 'react-native';
import { useRouter, Link, useLocalSearchParams } from 'expo-router';
import { AuthContainer, AuthLogo, AuthInput, AuthButton, AuthError } from '@/components/auth';
import { Button } from '@/components/ui/button';
import { MaterialCommunityIcons } from '@expo/vector-icons';
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
        router.replace(returnTo);
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

  return (
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
            <MaterialCommunityIcons name="google" size={18} color="#0F172A" />
            <Text className="text-sm font-medium">{t('login.continueWithGoogle')}</Text>
          </View>
        </Button>

        <Button
          variant="outline"
          onPress={() => handleSocialLogin('microsoft')}
          className="h-11 rounded-full"
        >
          <View className="flex-row items-center gap-2">
            <MaterialCommunityIcons name="microsoft" size={18} color="#0F172A" />
            <Text className="text-sm font-medium">{t('login.continueWithMicrosoft')}</Text>
          </View>
        </Button>

        <Button
          variant="outline"
          onPress={() => handleSocialLogin('apple')}
          className="h-11 rounded-full"
        >
          <View className="flex-row items-center gap-2">
            <MaterialCommunityIcons name="apple" size={18} color="#0F172A" />
            <Text className="text-sm font-medium">{t('login.continueWithApple')}</Text>
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
  );
}
