import React, { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { AuthContainer } from '@/components/auth/auth-container';
import { AuthLogo } from '@/components/auth/auth-logo';
import { AuthInput } from '@/components/auth/auth-input';
import { AuthButton } from '@/components/auth/auth-button';
import { AuthError } from '@/components/auth/auth-error';
import apiClient from '@/lib/api/client';
import { toast } from '@/components/sonner';
import { useTranslation } from '@/lib/hooks/use-translation';
import { errorMessage as getErrorMessage } from '@/lib/errors/error-utils';

export default function ForgotPasswordScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleResetPassword = async () => {
    if (!email.trim()) {
      setError(t('errors.emailRequired'));
      return;
    }

    setLoading(true);
    setError('');

    try {
      // Call API reset password endpoint
      await apiClient.post('/auth/forgot-password', {
        email: email.trim(),
      });

      setSent(true);
      toast.success(t('forgotPassword.checkEmailToast'));
      router.back();
    } catch (error: unknown) {
      console.error('Reset password error:', error);
      const errorMessage = getErrorMessage(error, t('forgotPassword.failedToSend'));
      setError(errorMessage);

      toast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthContainer>
      <AuthLogo />

      {sent ? (
            // Success State
            <View className="items-center">
              <Text className="text-2xl font-bold text-foreground tracking-tight mb-2 text-center">
                {t('forgotPassword.checkEmail')}
              </Text>
              <Text className="text-sm text-muted-foreground text-center mb-6 leading-5">
                {t('forgotPassword.sentInstructions')}{'\n'}
                <Text className="font-medium text-foreground">{email}</Text>
              </Text>
              <AuthButton
                onPress={() => router.back()}
                className="w-full"
              >
                {t('forgotPassword.returnToSignIn')}
              </AuthButton>
              <Pressable
                onPress={() => {
                  setSent(false);
                  setEmail('');
                }}
                className="mt-4"
              >
                <Text className="text-primary text-sm font-medium">
                  {t('forgotPassword.tryAnotherEmail')}
                </Text>
              </Pressable>
            </View>
      ) : (
        // Form State
        <>
          <View className="space-y-2 mb-6">
            <Text className="text-3xl font-bold text-foreground tracking-tight">
              {t('forgotPassword.title')}
            </Text>
            <Text className="text-base text-muted-foreground">
              {t('forgotPassword.subtitle')}
            </Text>
          </View>

          <View className="gap-3">
            <AuthError message={error} />

            <AuthInput
              placeholder={t('forgotPassword.emailPlaceholder')}
              value={email}
              onChangeText={(text) => {
                setEmail(text);
                setError('');
              }}
              autoCapitalize="none"
              keyboardType="email-address"
              editable={!loading}
              onSubmitEditing={handleResetPassword}
            />

            <AuthButton
              onPress={handleResetPassword}
              disabled={loading || !email}
              isLoading={loading}
              loadingText={t('forgotPassword.sending')}
              className="mt-3"
            >
              {t('common.continue')}
            </AuthButton>
          </View>
        </>
      )}

    </AuthContainer>
  );
}
