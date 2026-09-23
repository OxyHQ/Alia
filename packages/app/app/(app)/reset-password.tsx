import { AuthContainer } from '@/components/auth/auth-container';
import { AuthError } from '@/components/auth/auth-error';
import { AuthLogo } from '@/components/auth/auth-logo';
import apiClient from '@/lib/api/client';
import { errorMessage as getErrorMessage } from '@/lib/errors/error-utils';
import { useTranslation } from '@/lib/hooks/use-translation';
import { Button } from '@oxy.so/bloom/button';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';
import { useAuth } from '@oxy.so/services';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

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
    <AuthContainer>
      <AuthLogo />

      <View className="gap-2">
        <Text variant="title-1-bold">{t('resetPassword.title')}</Text>
        <Muted>{t('resetPassword.subtitle')}</Muted>
      </View>

      <View className="gap-3">
        <AuthError message={error} />

        <TextFieldInput
          label={t('resetPassword.newPasswordPlaceholder')}
          placeholder={t('resetPassword.newPasswordPlaceholder')}
          value={password}
          onChangeText={(text) => {
            setPassword(text);
            setError('');
          }}
          secureTextEntry
          editable={!loading && !!token}
        />

        <TextFieldInput
          label={t('resetPassword.confirmPasswordPlaceholder')}
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

        <Button
          tone="action"
          onPress={handleResetPassword}
          disabled={loading || !password || !confirmPassword || !token}
          loading={loading}
        >
          {t('resetPassword.resetButton')}
        </Button>
      </View>
    </AuthContainer>
  );
}
