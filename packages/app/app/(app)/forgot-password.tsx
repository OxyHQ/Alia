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
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

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
      const errorMessage = getErrorMessage(
        error,
        t('forgotPassword.failedToSend'),
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

      {sent ? (
        // Success state
        <View style={{ gap: 16, alignItems: 'center' }}>
          <Text variant="title-1-bold" style={{ textAlign: 'center' }}>
            {t('forgotPassword.checkEmail')}
          </Text>
          <Muted style={{ textAlign: 'center' }}>
            {t('forgotPassword.sentInstructions')}
            {'\n'}
            <Text variant="body-medium">{email}</Text>
          </Muted>
          <Button
            tone="action"
            style={{ alignSelf: 'stretch' }}
            onPress={() => router.back()}
          >
            {t('forgotPassword.returnToSignIn')}
          </Button>
          <Button
            tone="accent"
            appearance="plain"
            onPress={() => {
              setSent(false);
              setEmail('');
            }}
          >
            {t('forgotPassword.tryAnotherEmail')}
          </Button>
        </View>
      ) : (
        // Form state
        <View style={{ gap: 24 }}>
          <View style={{ gap: 8 }}>
            <Text variant="title-1-bold">{t('forgotPassword.title')}</Text>
            <Muted>{t('forgotPassword.subtitle')}</Muted>
          </View>

          <View style={{ gap: 12 }}>
            <AuthError message={error} />

            <TextFieldInput
              label={t('forgotPassword.emailPlaceholder')}
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

            <Button
              tone="action"
              onPress={handleResetPassword}
              disabled={loading || !email}
              loading={loading}
            >
              {t('common.continue')}
            </Button>
          </View>
        </View>
      )}
    </AuthContainer>
  );
}
