import { AuthContainer } from '@/components/auth/auth-container';
import { AuthError } from '@/components/auth/auth-error';
import { AuthLogo } from '@/components/auth/auth-logo';
import apiClient from '@/lib/api/client';
import { errorMessage as getErrorMessage } from '@/lib/errors/error-utils';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button as AuthButton } from '@oxy.so/bloom/button';
import { ContentPanel } from '@oxy.so/bloom/content-panel';
import { TextFieldInput as AuthInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

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
      const errorMessage = getErrorMessage(
        error,
        t('resetPassword.failedToReset'),
      );
      setError(errorMessage);

      toast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ContentPanel surfaceClassName="bg-background">
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
            label="Password"
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
            label="Password"
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
            loading={loading}
            className="mt-3"
          >
            {t('resetPassword.resetButton')}
          </AuthButton>
        </View>
      </AuthContainer>
    </ContentPanel>
  );
}
