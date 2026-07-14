import React, { useState, useEffect } from 'react';
import { View, Text } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuth } from '@oxyhq/services';
import { AuthContainer } from '@/components/auth/auth-container';
import { AuthLogo } from '@/components/auth/auth-logo';
import { AuthInput } from '@/components/auth/auth-input';
import { AuthButton } from '@/components/auth/auth-button';
import { AuthError } from '@/components/auth/auth-error';
import apiClient from '@/lib/api/client';
import { toast } from '@/components/sonner';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage as getErrorMessage } from '@/lib/errors/error-utils';

export default function ResetPasswordScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { signIn } = useAuth();
  const { token } = useLocalSearchParams<{ token: string }>();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) {
      setError(t('resetPassword.invalidToken'));
    }
  }, [token]);

  const handleResetPassword = async () => {
    setError('');

    if (!password.trim()) {
      const errorMsg = t('resetPassword.enterNewPassword');
      setError(errorMsg);
      toast.error(errorMsg);
      return;
    }

    if (password.length < 8) {
      const errorMsg = t('errors.passwordTooShort');
      setError(errorMsg);
      toast.error(errorMsg);
      return;
    }

    if (password !== confirmPassword) {
      const errorMsg = t('errors.passwordsDoNotMatch');
      setError(errorMsg);
      toast.error(errorMsg);
      return;
    }

    setLoading(true);

    try {
      await apiClient.post('/auth/reset-password', {
        token,
        password,
      });

      toast.success(t('resetPassword.successMessage'));
      router.replace('/');
      signIn().catch(() => {});
    } catch (error: unknown) {
      console.error('Reset password error:', error);
      const errorMessage = getErrorMessage(error, t('resetPassword.failedToReset'));
      setError(errorMessage);

      toast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthContainer>
      <AuthLogo />

      {/* Header */}
      <View className="space-y-2 mb-6">
        <Text className="text-3xl font-bold text-foreground tracking-tight">
          {t('resetPassword.title')}
        </Text>
        <Text className="text-base text-muted-foreground">
          {t('resetPassword.subtitle')}
        </Text>
      </View>

      {/* Form */}
      <View className="gap-3">
        <AuthError message={error} />

        <AuthInput
          placeholder={t('resetPassword.newPasswordPlaceholder')}
          value={password}
          onChangeText={(text) => {
            setPassword(text);
            setError('');
          }}
          secureTextEntry
          editable={!loading && !!token}
        />

        <AuthInput
          placeholder={t('resetPassword.confirmPasswordPlaceholder')}
          value={confirmPassword}
          onChangeText={(text) => {
            setConfirmPassword(text);
            setError('');
          }}
          secureTextEntry
          editable={!loading && !!token}
          onSubmitEditing={handleResetPassword}
        />

        <AuthButton
          onPress={handleResetPassword}
          disabled={loading || !password || !confirmPassword || !token}
          isLoading={loading}
          loadingText={t('resetPassword.resetting')}
          className="mt-3"
        >
          {t('resetPassword.resetButton')}
        </AuthButton>
      </View>
    </AuthContainer>
  );
}
